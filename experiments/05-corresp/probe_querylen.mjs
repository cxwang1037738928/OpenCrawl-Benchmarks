/**
 * probe_querylen.mjs — test whether the question template is drowning the entity.
 *
 * The retrieval probe found that count and set questions retrieve nearly the same documents
 * whatever entity they ask about (42% and 50% mean pairwise overlap of their top-10 doc sets,
 * against 4-8% for compare and holdout). Two count questions keyed on different accounting
 * standards -- ASC 605-25-25 and ASC 730-10-20 -- came back with an identical top four, none of
 * which concerned either standard.
 *
 * The suspected cause is proportion, not retrieval. A question reads
 *
 *   "How many distinct companies in this document set addressed ASC 730-10-20 in correspondence
 *    with the SEC staff, and how many of them agreed to revise their disclosure?"
 *
 * Twenty-eight words, of which the discriminating token is one, and that token is a digit string
 * a sentence embedder has little to represent. Mean-pooled over the whole sentence, the template
 * -- identical across every instance of the archetype -- dominates the vector.
 *
 * This re-runs the same questions as a bare entity query and compares reach. It changes nothing
 * about the task being asked; it only tests whether the phrasing is costing reach that the corpus
 * could otherwise supply. If the short form retrieves far better, the benchmark's questions are
 * measuring the template rather than the system.
 *
 * Run:  node probe_querylen.mjs --collection 34
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

const { values: flags } = parseArgs({ options: { collection: { type: 'string' } } });
createRequire(path.join(OPENCRAWL, 'package.json'))('dotenv')
  .config({ path: path.join(OPENCRAWL, '.env') });
const { retrieve } = await import(
  pathToFileURL(path.join(OPENCRAWL, 'backend', 'retriever', 'retriever.js')).href);
const { prisma } = await import(pathToFileURL(path.join(OPENCRAWL, 'backend', 'db.js')).href);

const TOP_K = Number(process.env.RETRIEVER_TOP_K ?? 10);
const EMBED_MODEL = process.env.CLIENT_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L12-v2';
let _ex = null;
const embed = async (t) => {
  if (!_ex) _ex = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
  return Array.from((await _ex([t], { pooling: 'mean', normalize: true })).data);
};

const collection = await prisma.collection.findUnique({
  where: { id: Number(flags.collection) },
  select: { id: true, name: true, corpusUpdatedAt: true, categories: true, embeddingsMeta: true },
});

const questions = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8'));
const evidence = JSON.parse(fs.readFileSync(path.join(HERE, 'evidence.mapped.json'), 'utf8'));

/** The same ask, stripped to the entity that distinguishes it from its siblings. */
function shortForm(q, hub) {
  switch (q.type) {
    case 'count':
    case 'set':       return hub;
    case 'recurring': return hub;
    case 'holdout':   return hub;
    case 'conjunctive': {
      // The company is the answer, so it cannot be named. Keep both subjects only.
      const m = q.question.match(/regarding (.+?) but separately declined to change its treatment of (.+?), defending/);
      return m ? `${m[1]} ${m[2]}` : hub;
    }
    default: return hub;
  }
}

/** Concise, entity-first, still an actual question. */
function conciseForm(q, hub) {
  switch (q.type) {
    case 'set':       return `${hub}: which companies cited it in SEC correspondence?`;
    case 'count':     return `${hub}: how many companies addressed it, and how many agreed to revise?`;
    case 'recurring': return `${hub}: which companies were asked about it in more than one year?`;
    case 'holdout':   return `${hub}: which companies defended their treatment rather than revising?`;
    case 'conjunctive': {
      const m = q.question.match(/regarding (.+?) but separately declined to change its treatment of (.+?), defending/);
      return m ? `Which company conceded on ${m[1]} but defended ${m[2]}?` : hub;
    }
    default: return q.question;
  }
}

const targets = questions.filter((q) =>
  ['count', 'set', 'recurring', 'conjunctive', 'holdout'].includes(q.type));

console.log(`comparing full question vs bare entity, ${targets.length} questions, topK=${TOP_K}\n`);
const out = [];
for (const [i, q] of targets.entries()) {
  const ev = evidence[q.id];
  const short = shortForm(q, ev.hub);
  const [vLong, vShort] = [await embed(q.question), await embed(short)];
  const runOne = async (vec, text) => {
    try {
      const got = await retrieve(collection, vec, text, { topK: TOP_K });
      const docs = [...new Set(got.map((c) => c.docId))];
      return ev.supportDocIds.filter((d) => docs.includes(d)).length;
    } catch { return 0; }
  };
  const concise = conciseForm(q, ev.hub);
  const vConcise = await embed(concise);
  const hitLong = await runOne(vLong, q.question);
  const hitShort = await runOne(vShort, short);
  const hitConcise = await runOne(vConcise, concise);
  out.push({ id: q.id, type: q.type, hub: ev.hub, need: ev.supportDocIds.length,
    short, concise, hitLong, hitShort, hitConcise });
  process.stdout.write(`  ${i + 1}/${targets.length}\r`);
}
console.log('\n');

const pct = (a, b) => `${(100 * a / Math.max(b, 1)).toFixed(0)}%`;
console.log('archetype      n     full          bare entity      concise question');
for (const t of [...new Set(out.map((o) => o.type))].sort()) {
  const rs = out.filter((o) => o.type === t);
  const aL = rs.filter((r) => r.hitLong > 0).length;
  const aS = rs.filter((r) => r.hitShort > 0).length;
  const rL = rs.reduce((s, r) => s + r.hitLong / r.need, 0) / rs.length;
  const rS = rs.reduce((s, r) => s + r.hitShort / r.need, 0) / rs.length;
  const aC = rs.filter((r) => r.hitConcise > 0).length;
  const rC = rs.reduce((s, r) => s + r.hitConcise / r.need, 0) / rs.length;
  console.log(`  ${t.padEnd(12)} ${String(rs.length).padStart(3)} ` +
    `${pct(aL, rs.length).padStart(9)}/${(100 * rL).toFixed(0).padStart(3)}%` +
    `${pct(aS, rs.length).padStart(14)}/${(100 * rS).toFixed(0).padStart(3)}%` +
    `${pct(aC, rs.length).padStart(15)}/${(100 * rC).toFixed(0).padStart(3)}%`);
}
const aL = out.filter((r) => r.hitLong > 0).length;
const aS = out.filter((r) => r.hitShort > 0).length;
const rL = out.reduce((s, r) => s + r.hitLong / r.need, 0) / out.length;
const rS = out.reduce((s, r) => s + r.hitShort / r.need, 0) / out.length;
const aC = out.filter((r) => r.hitConcise > 0).length;
const rC = out.reduce((s, r) => s + r.hitConcise / r.need, 0) / out.length;
console.log(`  ${'ALL'.padEnd(12)} ${String(out.length).padStart(3)} ` +
  `${pct(aL, out.length).padStart(9)}/${(100 * rL).toFixed(0).padStart(3)}%` +
  `${pct(aS, out.length).padStart(14)}/${(100 * rS).toFixed(0).padStart(3)}%` +
  `${pct(aC, out.length).padStart(15)}/${(100 * rC).toFixed(0).padStart(3)}%`);

const improved = out.filter((r) => r.hitShort > r.hitLong);
const worsened = out.filter((r) => r.hitShort < r.hitLong);
console.log(`\nquestions improved by the short form: ${improved.length}`);
console.log(`questions made worse                : ${worsened.length}`);
console.log('\nbiggest gains:');
for (const r of improved.sort((a, b) => (b.hitShort - b.hitLong) - (a.hitShort - a.hitLong)).slice(0, 8)) {
  console.log(`  ${r.id}  ${r.type.padEnd(11)} ${String(r.hub).padEnd(34)} ${r.hitLong} -> ${r.hitShort} of ${r.need}`);
}
fs.writeFileSync(path.join(HERE, 'raw', 'querylen_probe.json'), JSON.stringify(out, null, 1));
await prisma.$disconnect();
