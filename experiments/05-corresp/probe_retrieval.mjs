/**
 * probe_retrieval.mjs — run the real retriever over a sample of the 183 questions. No LLM.
 *
 * This answers the question that decides whether the benchmark is worth running at all: when a
 * question asks something aggregative, does chunk retrieval actually reach the letters that hold
 * the answer? Experiment 04's dominant finding was that retrieval reach, not graph presence,
 * decided an answer -- 75% correct where retrieval reached the support document, 26% where it did
 * not. If reach is near zero here, every arm scores near zero and the run measures nothing; if it
 * is near total, the graph has no gap to fill. Either extreme is worth knowing before spending.
 *
 * retrieve() is imported and called in-process exactly as main.js does it, because POST /chat
 * always synthesises an answer and there is no way to observe retrieval alone through the API.
 * Queries are embedded with this repo's own MiniLM using the pooling and normalization the corpus
 * was built with -- a different vector space retrieves badly without ever erroring.
 *
 * Run:  node probe_retrieval.mjs --collection 34 [--n 80] [--dump 12]
 *   --collection <id>  indexed collection to query          (required)
 *   --n <count>        questions to sample, stratified      (default 80)
 *   --dump <count>     questions whose chunks to print      (default 10)
 *   --type <archetype> restrict the sample to one archetype
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pipeline } from '@xenova/transformers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');

const { values: flags } = parseArgs({
  options: {
    collection: { type: 'string' },
    n: { type: 'string', default: '80' },
    dump: { type: 'string', default: '10' },
    type: { type: 'string' },
  },
});
if (!flags.collection) { console.error('--collection <id> required'); process.exit(1); }

// The sibling's modules read env at import time, so .env must load first.
createRequire(path.join(OPENCRAWL, 'package.json'))('dotenv')
  .config({ path: path.join(OPENCRAWL, '.env') });
const { retrieve } = await import(
  pathToFileURL(path.join(OPENCRAWL, 'backend', 'retriever', 'retriever.js')).href);
const { prisma } = await import(
  pathToFileURL(path.join(OPENCRAWL, 'backend', 'db.js')).href);

const TOP_K = Number(process.env.RETRIEVER_TOP_K ?? 10);
const EMBED_MODEL = process.env.CLIENT_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L12-v2';

let _extractor = null;
async function embedText(text) {
  if (!_extractor) _extractor = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
  const out = await _extractor([text], { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

const collection = await prisma.collection.findUnique({
  where: { id: Number(flags.collection) },
  select: { id: true, name: true, corpusUpdatedAt: true, categories: true, embeddingsMeta: true },
});
if (!collection) { console.error(`no collection ${flags.collection}`); process.exit(1); }

const questions = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8'));
const evidence = JSON.parse(fs.readFileSync(path.join(HERE, 'evidence.mapped.json'), 'utf8'));
const docName = new Map();          // docId -> letter name, for readable output
for (const ev of Object.values(evidence)) {
  ev.supportDocIds.forEach((id, i) => docName.set(id, ev.supportDocNames[i]));
}

// Stratified: every archetype must appear, or the sample says nothing about the ones it misses.
const byType = new Map();
for (const q of questions) {
  if (flags.type && q.type !== flags.type) continue;
  if (!byType.has(q.type)) byType.set(q.type, []);
  byType.get(q.type).push(q);
}
const want = Number(flags.n);
const sample = [];
for (let i = 0; sample.length < want; i += 1) {
  let progressed = false;
  for (const list of byType.values()) {
    if (i < list.length && sample.length < want) { sample.push(list[i]); progressed = true; }
  }
  if (!progressed) break;
}

console.log(`collection ${collection.id} "${collection.name}"`);
console.log(`retriever   : in-process, topK=${TOP_K}, no LLM`);
console.log(`embedding   : ${EMBED_MODEL} (quantized, mean pooling, L2-normalized)`);
console.log(`sampling    : ${sample.length} of ${questions.length} questions, stratified\n`);

const rows = [];
for (const [i, q] of sample.entries()) {
  const ev = evidence[q.id];
  const vec = await embedText(q.question);
  let chunks = [];
  let error = null;
  try {
    const got = await retrieve(collection, vec, q.question, { topK: TOP_K });
    chunks = got.map(({ embedding, ...c }) => c);
  } catch (err) { error = err.message; }

  const gotDocs = [...new Set(chunks.map((c) => c.docId))];
  const hit = ev.supportDocIds.filter((d) => gotDocs.includes(d));
  rows.push({
    id: q.id, type: q.type, question: q.question, expected: q.expectedAnswer,
    need: ev.supportDocIds, needNames: ev.supportDocNames, hub: ev.hub,
    gotDocs, hit, chunks, error,
  });
  process.stdout.write(`  retrieved ${i + 1}/${sample.length}\r`);
}
console.log('\n');

fs.writeFileSync(path.join(HERE, 'raw', 'retrieval_probe.json'), JSON.stringify(rows, null, 1));

// ------------------------------------------------------------------ summary
const pct = (a, b) => `${(100 * a / Math.max(b, 1)).toFixed(0)}%`;
console.log('archetype      n   supportDocs  distinctDocs   any hit   all hit   mean recall');
for (const t of [...byType.keys()].sort()) {
  const rs = rows.filter((r) => r.type === t);
  if (!rs.length) continue;
  const need = rs.reduce((s, r) => s + r.need.length, 0) / rs.length;
  const dist = rs.reduce((s, r) => s + r.gotDocs.length, 0) / rs.length;
  const any = rs.filter((r) => r.hit.length > 0).length;
  const all = rs.filter((r) => r.hit.length === r.need.length).length;
  const rec = rs.reduce((s, r) => s + r.hit.length / Math.max(r.need.length, 1), 0) / rs.length;
  console.log(`  ${t.padEnd(12)} ${String(rs.length).padStart(3)} ` +
    `${need.toFixed(1).padStart(12)} ${dist.toFixed(1).padStart(13)} ` +
    `${pct(any, rs.length).padStart(9)} ${pct(all, rs.length).padStart(9)} ` +
    `${(100 * rec).toFixed(0).padStart(12)}%`);
}
const anyAll = rows.filter((r) => r.hit.length > 0).length;
const allAll = rows.filter((r) => r.hit.length === r.need.length).length;
const recAll = rows.reduce((s, r) => s + r.hit.length / Math.max(r.need.length, 1), 0) / rows.length;
console.log(`  ${'ALL'.padEnd(12)} ${String(rows.length).padStart(3)} ` +
  `${''.padStart(12)} ${''.padStart(13)} ${pct(anyAll, rows.length).padStart(9)} ` +
  `${pct(allAll, rows.length).padStart(9)} ${(100 * recAll).toFixed(0).padStart(12)}%`);

console.log('\nrecall = fraction of a question\'s support letters that appeared in the top-' +
  TOP_K + ' chunks');
console.log(`questions where retrieval reached NOTHING: ${rows.length - anyAll}`);
console.log('\nwrote raw/retrieval_probe.json');
await prisma.$disconnect();
