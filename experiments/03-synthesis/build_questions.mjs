/**
 * build_questions.mjs — turn questions.source.json into questions.json + evidence.json
 *
 * The source file is authored by hand from the two review PDFs in this folder: each
 * record carries the question, the review's own claim as the expected answer, the
 * citation numbers it came from, and one `verify` pattern per COMPONENT of that claim.
 *
 * This script is the check, not the author. For every verify pattern it finds the
 * collection-26 chunk that literally contains the component and records that chunkId
 * with a verbatim quote. A pattern that matches nothing is a hard failure: it means the
 * review states something the corpus cannot support, and the question would be
 * unanswerable rather than hard. Those are reported and the build refuses to emit.
 *
 * It also enforces the two retrieval rules the benchmark depends on, using OpenCrawl's
 * own code rather than a reimplementation:
 *   - every question must seed the knowledge graph (>=1 entity in >=2 documents),
 *     or collection 26 has no way to differ from the graph-free clone;
 *   - no question may resolve a document name, or RETRIEVER_DOC_BOOST would hand it a
 *     2.0x boost and turn a synthesis question into a lookup.
 *
 * Run:  node "Synthesis benchmark/build_questions.mjs" [--emit]
 *       without --emit it reports only, and writes nothing.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENCRAWL = process.env.OPENCRAWL_DIR
  || path.resolve(HERE, '..', '..', 'OpenCrawl');
const COLLECTION_ID = Number(process.env.COLLECTION_ID || 26);
const EMIT = process.argv.includes('--emit');

// Authored in batches so a failing pattern is found while its claim is still fresh;
// every questions.source*.json in this folder is concatenated, in name order.
const SOURCE_GLOB = /^questions\.source.*\.json$/;
const OUT_Q    = path.join(HERE, 'questions.json');
const OUT_EVID = path.join(HERE, 'evidence.json');

const TYPES = ['single_doc', 'cross_doc', 'multi_hop', 'enumerate'];
const EXPECTED_COUNTS = { single_doc: 40, cross_doc: 80, multi_hop: 60, enumerate: 20 };

// Modules read env at import time, so .env first.
createRequire(path.join(OPENCRAWL, 'package.json'))('dotenv')
  .config({ path: path.join(OPENCRAWL, '.env') });
const sibling = (...parts) => pathToFileURL(path.join(OPENCRAWL, ...parts)).href;

const { prisma }        = await import(sibling('backend', 'db.js'));
const { resolveDocIds } = await import(sibling('backend', 'retriever', 'retriever.js'));
const { buildGraphIndex, matchSeeds } =
  await import(sibling('backend', 'retriever', 'graph_retriever.js'));

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const documents = await prisma.document.findMany({
  where: { collectionId: COLLECTION_ID },
  select: { docId: true, filename: true, title: true },
});
const titleOf = Object.fromEntries(documents.map((d) => [d.docId, d.title]));

const chunks = await prisma.chunk.findMany({
  where: { collectionId: COLLECTION_ID },
  select: { chunkId: true, docId: true, chunkIndex: true, pages: true, text: true },
  orderBy: [{ docId: 'asc' }, { chunkIndex: 'asc' }],
});
const chunksByDoc = new Map();
for (const c of chunks) {
  if (!chunksByDoc.has(c.docId)) chunksByDoc.set(c.docId, []);
  chunksByDoc.get(c.docId).push(c);
}

// The graph, straight off the collection row — the same payload retrieveFacts uses.
const { knowledgeGraph } = await prisma.collection.findUniqueOrThrow({
  where: { id: COLLECTION_ID }, select: { knowledgeGraph: true },
});
const graphIndex = buildGraphIndex(knowledgeGraph);
if (!graphIndex) throw new Error(`collection ${COLLECTION_ID} has no usable knowledge graph`);

// Mirrors buildDocIndex in retriever.js, which is not exported. Kept in step with it
// so the no-doc-boost check tests what the retriever will actually do.
const normalizeDocName = (text) => String(text || '')
  .toLowerCase().replace(/\.pdf$/, '').replace(/[_\s]+/g, ' ').trim();
const docIndex = documents.map((doc) => {
  const name = normalizeDocName(doc.filename);
  const [first, ...rest] = name.split(' ');
  const numbered = /^\d+(?:\.\d+)*$/.test(first);
  const title = String(doc.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const letters = (title.match(/[a-z ]/g) || []).length;
  return {
    docId: doc.docId,
    name: name.length >= 5 ? name : null,
    number: numbered ? first : null,
    words: (numbered ? rest : name.split(' ')).filter((w) => w.length > 2),
    title: title.length >= 25 && letters / title.length >= 0.6 ? title : null,
  };
});

const MIN_SEED_DOC_FREQ = parseInt(process.env.GRAPH_MIN_SEED_DOC_FREQ || '2', 10);
const seedsFor = (text) => matchSeeds(text, graphIndex).seeds
  .map((name) => ({ name, docFreq: graphIndex.docsOf.get(name)?.size || 0 }))
  .filter((s) => s.docFreq >= MIN_SEED_DOC_FREQ)
  .sort((a, b) => a.docFreq - b.docFreq);

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Collapse whitespace so a quote reads cleanly regardless of PDF line breaks. */
const tidy = (text) => text.replace(/\s+/g, ' ').trim();

/** The window of `text` around a match, trimmed to word boundaries. */
function quoteAround(text, index, length, width = 260) {
  const start = Math.max(0, index - Math.floor((width - length) / 2));
  let excerpt = text.slice(start, start + width);
  if (start > 0) excerpt = excerpt.replace(/^\S*\s/, '');
  if (start + width < text.length) excerpt = excerpt.replace(/\s\S*$/, '');
  return tidy(excerpt);
}

/**
 * Find the chunk that supports one component of a claim.
 * Scoped to the document the source record names, because "this number appears
 * somewhere in 192 papers" is not evidence that the CITED paper states it.
 */
function verifyComponent({ docId, re }) {
  const pool = chunksByDoc.get(docId);
  if (!pool) return { ok: false, reason: `no document ${docId} in collection ${COLLECTION_ID}` };
  const pattern = new RegExp(re, 'i');
  for (const chunk of pool) {
    // Matched against whitespace-NORMALIZED text. PDF justification leaves double
    // spaces mid-sentence ("constraints  and  restricted  open-source  availability"),
    // so a pattern copied from the paper fails on the raw string for a reason that has
    // nothing to do with whether the corpus states the fact. Quotes are tidied for
    // display anyway, so normalizing loses nothing.
    const text = tidy(chunk.text);
    const match = pattern.exec(text);
    if (!match) continue;
    return {
      ok: true,
      chunkId: chunk.chunkId,
      docId,
      pages: chunk.pages,
      quote: quoteAround(text, match.index, match[0].length),
    };
  }
  return { ok: false, reason: `/${re}/i matches no chunk of ${docId} (${titleOf[docId]})` };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const sourceFiles = (await fs.readdir(HERE)).filter((f) => SOURCE_GLOB.test(f)).sort();
if (!sourceFiles.length) throw new Error(`no questions.source*.json in ${HERE}`);
const source = [];
for (const file of sourceFiles) {
  source.push(...JSON.parse(await fs.readFile(path.join(HERE, file), 'utf-8')));
}
console.log(`source files        : ${sourceFiles.join(', ')}`);

const problems = [];
const questions = [];
const evidence = {};
const seenIds = new Set();
const seenQuestions = new Set();

for (const record of source) {
  const fail = (message) => problems.push(`${record.id ?? '(no id)'}: ${message}`);

  if (!record.id || seenIds.has(record.id)) fail(`duplicate or missing id`);
  seenIds.add(record.id);
  if (!TYPES.includes(record.type)) fail(`unknown type "${record.type}"`);
  if (!record.question?.trim()) fail('empty question');
  if (!record.expectedAnswer?.trim()) fail('empty expectedAnswer');

  const normalized = record.question.toLowerCase().replace(/\s+/g, ' ').trim();
  if (seenQuestions.has(normalized)) fail('duplicate question text');
  seenQuestions.add(normalized);

  // Retrieval rules, checked with the real retriever code.
  const boosted = resolveDocIds(record.question, docIndex);
  if (boosted.size) {
    fail(`resolves ${boosted.size} document name(s) -> would get the 2.0x doc boost`);
  }
  const seeds = seedsFor(record.question);
  if (!seeds.length) fail('seeds no graph entity appearing in >=2 documents');

  // Evidence.
  const resolved = [];
  for (const component of record.verify ?? []) {
    const result = verifyComponent(component);
    if (!result.ok) { fail(result.reason); continue; }
    resolved.push(result);
  }
  if (!(record.verify ?? []).length) fail('no verify patterns');

  const supportDocIds = [...new Set(resolved.map((r) => r.docId))];
  if (record.type === 'single_doc' && supportDocIds.length !== 1) {
    fail(`single_doc but spans ${supportDocIds.length} documents`);
  }
  if (['cross_doc', 'multi_hop'].includes(record.type) && supportDocIds.length < 2) {
    fail(`${record.type} but only ${supportDocIds.length} support document(s)`);
  }
  if (record.type === 'enumerate' && supportDocIds.length < 3) {
    fail(`enumerate but only ${supportDocIds.length} support document(s)`);
  }

  questions.push({
    id: record.id,
    type: record.type,
    question: tidy(record.question),
    expectedAnswer: tidy(record.expectedAnswer),
  });
  evidence[record.id] = {
    source: record.source,
    supportDocIds,
    supportTitles: supportDocIds.map((d) => titleOf[d]),
    supportChunkIds: resolved.map((r) => r.chunkId),
    evidence: resolved.map((r) => ({ chunkId: r.chunkId, pages: r.pages, quote: r.quote })),
    seedEntities: seeds.slice(0, 6),
  };
}

// Composition.
const counts = Object.fromEntries(TYPES.map((t) => [t, questions.filter((q) => q.type === t).length]));
for (const type of TYPES) {
  if (counts[type] !== EXPECTED_COUNTS[type]) {
    problems.push(`composition: ${type} is ${counts[type]}, expected ${EXPECTED_COUNTS[type]}`);
  }
}

console.log(`source records      : ${source.length}`);
console.log(`type counts         : ${TYPES.map((t) => `${t} ${counts[t]}`).join(' · ')}`);
console.log(`evidence components : ${Object.values(evidence).reduce((n, e) => n + e.evidence.length, 0)}`);
console.log(`documents cited     : ${new Set(Object.values(evidence).flatMap((e) => e.supportDocIds)).size}`
  + ` of ${documents.length}`);

if (problems.length) {
  console.error(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
  if (problems.length > 60) console.error(`  … and ${problems.length - 60} more`);
  if (EMIT) console.error('\nrefusing to emit');
  await prisma.$disconnect();
  process.exit(1);
}

if (EMIT) {
  await fs.writeFile(OUT_Q, `${JSON.stringify(questions, null, 1)}\n`, 'utf-8');
  await fs.writeFile(OUT_EVID, `${JSON.stringify(evidence, null, 1)}\n`, 'utf-8');
  console.log(`\nwrote ${path.basename(OUT_Q)} and ${path.basename(OUT_EVID)}`);
} else {
  console.log('\nall checks passed (run with --emit to write)');
}

await prisma.$disconnect();
