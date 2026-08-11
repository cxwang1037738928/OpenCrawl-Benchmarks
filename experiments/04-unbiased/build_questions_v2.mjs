/**
 * build_questions_v2.mjs — a question set built WITHOUT the retrieval bias
 *
 * Why this exists. The 03-synthesis set was authored from two review PDFs and then
 * gated on a hard rule: every component of every expected answer had to appear as a
 * literal substring of a collection-26 chunk. That rule is what makes those questions
 * fair, and it is also exactly why the knowledge graph is worth only +5 answers in
 * 200 — if the answer is always sitting in a chunk, chunk retrieval can always reach
 * it and the graph is a redundant second path. The benchmark could not see the graph
 * contribute because it had selected for questions that never need it.
 *
 * The fix is NOT to select for questions the graph wins; that just moves the bias and
 * produces a number you can dial with a threshold. Perfect neutrality is unavailable
 * in generation — a question written from a chunk tends to retrieve that chunk, and
 * one written from the graph inherits the graph's extraction errors. What IS available
 * is neutrality in SELECTION:
 *
 *   - questions are generated from DOCUMENT text sampled uniformly across the corpus,
 *     not from the reviews and not from the graph;
 *   - nothing is ever filtered on whether retrieval or the graph can answer it;
 *   - both reachabilities are MEASURED and recorded as strata.
 *
 * The headline accuracy is then unbiased, and the graph's ceiling falls out of the
 * same run as the chunkReach=false stratum rather than as a separate rigged set.
 *
 * Two rules from the old builder are deliberately NOT carried over:
 *
 *   1. "every answer component must be a literal chunk substring" — this is the bias.
 *      Replaced by: the answer must be supported by the sampled document window, which
 *      is verified, but may span several chunks and need not survive top-k retrieval.
 *   2. "every question must seed the knowledge graph" — the old builder required this
 *      so the arms could differ. It also hid a number worth having: how often a natural
 *      question engages the graph AT ALL. Recorded now, not required.
 *
 * The one rule kept: a question may not name a document, or RETRIEVER_DOC_BOOST hands
 * it a 2.0x boost and turns a synthesis question into a lookup.
 *
 * Run:  node experiments/04-unbiased/build_questions_v2.mjs --n 200 [--emit]
 *       without --emit it reports and writes nothing.
 */

process.env.GRAPH_MAX_FACTS = process.env.GRAPH_MAX_FACTS || '25';

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR || path.resolve(ROOT, '..', 'OpenCrawl');
const COLLECTION_ID = Number(process.env.COLLECTION_ID || 26);

const { values: flags } = parseArgs({
  options: {
    n:       { type: 'string' },
    emit:    { type: 'boolean', default: false },
    seed:    { type: 'string' },
    resume:  { type: 'boolean', default: false },
  },
});
const TARGET = Number(flags.n || 200);
const SEED = Number(flags.seed || 20260810);

const OUT_Q     = path.join(HERE, 'questions.v2.json');
const OUT_EVID  = path.join(HERE, 'evidence.v2.json');
const OUT_RAW   = path.join(HERE, 'generated.raw.jsonl');   // resumable scratch

const LOG = '[v2]';
const say = (...m) => console.log(LOG, ...m);
const fail = (m) => { console.error(`${LOG} ${m}`); process.exit(1); };

createRequire(path.join(OPENCRAWL, 'package.json'))('dotenv')
  .config({ path: path.join(OPENCRAWL, '.env') });
const sibling = (...parts) => pathToFileURL(path.join(OPENCRAWL, ...parts)).href;

const { prisma }        = await import(sibling('backend', 'db.js'));
const { retrieve, retrieveFacts, resolveDocIds } =
  await import(sibling('backend', 'retriever', 'retriever.js'));

const { pipeline } = await import(pathToFileURL(
  createRequire(path.join(ROOT, 'package.json')).resolve('@xenova/transformers')).href);

// ---------------------------------------------------------------------------
// Deterministic sampling — the set must be reproducible from --seed alone
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

const collection = await prisma.collection.findUnique({
  where: { id: COLLECTION_ID },
  select: { id: true, name: true, userId: true, categories: true,
            embeddingsMeta: true, knowledgeGraph: true },
});
if (!collection) fail(`no collection ${COLLECTION_ID}`);

const documents = await prisma.document.findMany({
  where: { collectionId: COLLECTION_ID },
  select: { docId: true, filename: true, title: true },
});
const chunks = await prisma.chunk.findMany({
  where: { collectionId: COLLECTION_ID },
  select: { chunkId: true, docId: true, chunkIndex: true, text: true, pages: true },
  orderBy: [{ docId: 'asc' }, { chunkIndex: 'asc' }],
});

// Mirrors buildDocIndex in retriever.js, which is not exported — kept in step with it
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

const byDoc = new Map();
for (const c of chunks) {
  if (!byDoc.has(c.docId)) byDoc.set(c.docId, []);
  byDoc.get(c.docId).push(c);
}
say(`collection ${COLLECTION_ID} "${collection.name}": ${documents.length} documents, `
  + `${chunks.length} chunks, graph ${collection.knowledgeGraph?.entities?.length ?? 0} entities`);

// Uniform over DOCUMENTS, not chunks: sampling chunks would draw questions
// preferentially from long papers, which is a second bias on top of the one
// this file exists to remove.
const docTitle = new Map(documents.map((d) => [d.docId, d.title || d.filename]));
const eligible = documents.filter((d) => (byDoc.get(d.docId)?.length ?? 0) >= 3);
say(`${eligible.length} documents have >=3 chunks and are eligible as sources`);

// Document pairs that share a RARE term in their chunk text. The term index is built
// from the corpus, deliberately not from the knowledge graph: pairing documents by
// graph edges would seed the set with exactly the relations the graph already knows,
// which is the circularity that makes a graph-sourced benchmark meaningless.
const RARE_MIN_DOCS = 2;
const RARE_MAX_DOCS = 6;
const termDocs = new Map();
for (const c of chunks) {
  for (const t of new Set(String(c.text).toLowerCase().match(/[a-z][a-z0-9-]{5,}/g) ?? [])) {
    if (!termDocs.has(t)) termDocs.set(t, new Set());
    termDocs.get(t).add(c.docId);
  }
}
const pairKey = (a, b) => (a < b ? `${a}||${b}` : `${b}||${a}`);
const pairTerms = new Map();
for (const [term, docs] of termDocs) {
  if (docs.size < RARE_MIN_DOCS || docs.size > RARE_MAX_DOCS) continue;
  const list = [...docs].filter((d) => byDoc.has(d));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const k = pairKey(list[i], list[j]);
      if (!pairTerms.has(k)) pairTerms.set(k, []);
      pairTerms.get(k).push(term);
    }
  }
}
// Require several shared rare terms, or the "pair" is a coincidence of one odd word.
const goodPairs = shuffle([...pairTerms.entries()]
  .filter(([, ts]) => ts.length >= 4)
  .map(([k, ts]) => ({ docs: k.split('||'), terms: ts })));
say(`${goodPairs.length} document pairs share >=4 rare terms (from chunk text, not the graph)`);

// Half single-document, half cross-document. The single half keeps the set honest —
// most real questions are answerable from one paper — and the cross half is where the
// graph has anything structural to offer.
const order = shuffle(eligible);
const plan = [];
for (let i = 0; plan.length < TARGET; i++) {
  if (i % 2 === 0 || !goodPairs.length) {
    const doc = order[(i >> 1) % order.length];
    plan.push({ mode: 'single', doc, pass: Math.floor((i >> 1) / order.length) });
  } else {
    plan.push({ mode: 'pair', pair: goodPairs[(i >> 1) % goodPairs.length] });
  }
}
say(`sampling ${plan.length} slots: ${plan.filter((p) => p.mode === 'single').length} single-doc, `
  + `${plan.filter((p) => p.mode === 'pair').length} cross-doc`);

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const MODEL = (process.env.REASONING_MODEL || 'gemini/gemini-3.1-flash-lite')
  .replace(/^gemini\//i, '');
const BASE = (process.env.GEMINI_BASE_URL
  || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/?$/, '/');
const KEY = (process.env.GEMINI_API_KEY || '').trim();
if (!KEY) fail('GEMINI_API_KEY is not set');

const SHARED_RULES = `
Hard requirements:
1. The answer must be fully supported by the excerpt(s). Do not use outside knowledge.
2. Do NOT name the paper, its title, its authors, or its filename in the question.
3. PARAPHRASE HARD. This is the most important rule. A reader must be able to ask your
   question without having seen the text. Name the technical subject (a model, dataset,
   method or material) because the question needs it — but express everything ELSE in
   ordinary words. Do not lift distinctive phrases, section wording, or unusual adjectives
   from the excerpt. If the excerpt says "exhibits markedly superior data efficiency in
   the low-data regime", ask "how well does it do with little training data".
4. The question must be self-contained. Never write "this paper", "this study", "the
   authors", "the excerpt" or "Figure 3" — the reader does not know which document it
   came from. Refer to the subject matter by name instead.
5. The expected answer must be 1-3 sentences and factual.

Reply with ONLY a JSON object:
{"question": "...", "expectedAnswer": "...", "supportQuote": "<= 300 chars copied EXACTLY AND VERBATIM from the excerpt, character for character, containing the answer"}`;

const SYSTEM = `You write questions for a retrieval benchmark over a corpus of materials-science papers.

You are given an excerpt from ONE paper. Write ONE question that the excerpt answers.
${SHARED_RULES}`;

// The single-document mode cannot escape the bias this file exists to remove: a question
// written from one window is a question that window answers, so chunk retrieval finds it.
// A question that genuinely needs TWO documents has no single chunk that holds its answer,
// which is the only construction where the graph has something retrieval structurally
// lacks. Document pairs are found by SHARED RARE TERMS IN CHUNK TEXT, not by the graph —
// sourcing pairs from the graph would bias the set toward facts the graph already holds.
const SYSTEM_PAIR = `You write questions for a retrieval benchmark over a corpus of materials-science papers.

You are given excerpts from TWO DIFFERENT papers. Write ONE question that can only be
answered by combining information from BOTH excerpts — a comparison, a relationship, or a
claim that neither excerpt supports on its own. If the two excerpts have nothing
substantive in common, reply exactly {"skip": true} and nothing else.
${SHARED_RULES}`;

async function generate(excerpt, system = SYSTEM) {
  const res = await fetch(`${BASE}chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.4,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: excerpt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`${res.status} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in reply: ${text.slice(0, 160)}`);
  return JSON.parse(m[0]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A window of consecutive chunks: enough context that the answer can need more than
// one chunk, which is precisely what the old builder's literal-substring gate forbade.
function windowFor(docId, pass) {
  const cs = byDoc.get(docId);
  const span = Math.min(3, cs.length);
  const start = Math.floor(rand() * Math.max(1, cs.length - span));
  const slice = cs.slice(start, start + span);
  return { slice, text: slice.map((c) => c.text).join('\n\n').slice(0, 7000) };
}

const done = new Map();
if (flags.resume && fsSync.existsSync(OUT_RAW)) {
  for (const line of fsSync.readFileSync(OUT_RAW, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    done.set(r.slot, r);
  }
  say(`resuming: ${done.size} slots already generated`);
}

const rawOut = fsSync.createWriteStream(OUT_RAW, { flags: flags.resume ? 'a' : 'w' });
const generated = [];
let skipped = 0;
for (const [i, slot] of plan.entries()) {
  if (done.has(i)) { generated.push(done.get(i)); continue; }

  let docIds, slice, text, system;
  if (slot.mode === 'single') {
    const w = windowFor(slot.doc.docId, slot.pass);
    docIds = [slot.doc.docId];
    slice = w.slice;
    text = `EXCERPT:\n\n${w.text}`;
    system = SYSTEM;
  } else {
    const [a, b] = slot.pair.docs;
    const wa = windowFor(a, 0), wb = windowFor(b, 0);
    docIds = [a, b];
    slice = [...wa.slice, ...wb.slice];
    text = `EXCERPT FROM PAPER A:\n\n${wa.text.slice(0, 3500)}\n\n`
         + `EXCERPT FROM PAPER B:\n\n${wb.text.slice(0, 3500)}`;
    system = SYSTEM_PAIR;
  }

  let out = null;
  for (let attempt = 0; attempt < 4 && !out; attempt++) {
    try {
      out = await generate(text, system);
    } catch (e) {
      if (attempt === 3) { say(`slot ${i}: giving up — ${e.message}`); break; }
      await sleep([2000, 8000, 20000][attempt]);
    }
  }
  if (out?.skip) { skipped++; continue; }
  if (!out?.question || !out?.expectedAnswer) continue;
  const rec = {
    slot: i,
    mode: slot.mode,
    docId: docIds[0],
    docIds,
    title: docIds.map((d) => docTitle.get(d)).join(' || '),
    chunkIds: slice.map((c) => c.chunkId),
    pages: slice.flatMap((c) => c.pages ?? []),
    question: String(out.question).trim(),
    expectedAnswer: String(out.expectedAnswer).trim(),
    supportQuote: String(out.supportQuote ?? '').trim(),
    windowText: text,
  };
  generated.push(rec);
  rawOut.write(`${JSON.stringify(rec)}\n`);
  if ((i + 1) % 20 === 0) say(`generated ${i + 1}/${plan.length}`);
  await sleep(400);
}
rawOut.end();
say(`generated ${generated.length} raw questions (${skipped} pairs skipped as unrelated)`);

// ---------------------------------------------------------------------------
// Fairness checks — these reject BAD questions, never UNREACHABLE ones
// ---------------------------------------------------------------------------

const STOP = new Set(('the a an of and or to in for on with by is are was were be been as '
  + 'that this these those it its from at which what how why when who whom whose does do '
  + 'did can could should would may might will shall not no nor but if then than there '
  + 'here also such into over under between among during about above below up down out '
  + 'off again further once all any both each few more most other some only own same so '
  + 'too very using used use paper study authors research work approach method results')
  .split(' '));
const terms = (s) => [...new Set(String(s).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])]
  .filter((t) => !STOP.has(t));

// Which of the question's terms were LIFTED from the source window.
//
// Counting every shared content term measures nothing: a question about NequIP's data
// efficiency legitimately contains "nequip", "training" and "data", all of which are in
// the window, and scores 0.6 while being a perfectly good paraphrase. Only RARE terms
// are evidence of copying, because only rare terms drive BM25 — a term in 150 of 192
// documents cannot single out the source chunk no matter who wrote it.
//
// Rarity comes from termDocs, the corpus-wide document-frequency index built above.
const RARE_DF = 20;                       // ~10% of the 192-document corpus
const isRare = (t) => (termDocs.get(t)?.size ?? 0) <= RARE_DF;
function lifted(question, windowText) {
  const w = new Set(terms(windowText));
  const rare = terms(question).filter(isRare);
  const shared = rare.filter((t) => w.has(t));
  // Absolute count, not a fraction: a question MUST name its subject, and the subject
  // is always rare and always in the window. One or two shared rare terms is the floor
  // of asking the question at all; five is lifting the sentence.
  return { rare: rare.length, shared: shared.length, terms: shared };
}

// A question that points at its own source is unanswerable to anyone who cannot see
// which document it came from — it fails in every arm and measures nothing, which is
// the defect that put 29 dead questions in the 03-synthesis set. The pair prompt
// provokes a whole extra family of these ("the first text", "both excerpts"), so the
// pattern list is wider than the obvious one.
const SELF_REF = new RegExp([
  /this (paper|study|work|article|excerpt|passage|document|text|source|review)/,
  /the (excerpt|passage|authors|paper|study|article|document|source|review)\b/,
  /\b(the|both)\s+(first|second)\s+(text|excerpt|passage|paper|study|document)/,
  /\bboth (texts|excerpts|passages|papers|studies|documents)\b/,
  /the (proposed|described|presented|discussed|outlined|developed|aforementioned)\s/,
  /\b(figure|table|section|appendix|equation)\s*\d/,
].map((r) => r.source).join('|'), 'i');

const rejected = [];
const kept = [];
for (const g of generated) {
  const lift = lifted(g.question, g.windowText);
  const ov = lift.shared;
  // resolveDocIds is OpenCrawl's own name matcher — a question it resolves would get
  // the 2.0x document boost and stop being a synthesis question.
  const resolved = [...(resolveDocIds(g.question, docIndex) ?? [])];
  if (SELF_REF.test(g.question)) { rejected.push({ ...g, why: 'self-referential question' }); continue; }
  // The positive form of the same rule, and the stronger one: a self-contained question
  // must NAME something. With no rare term it identifies no model, dataset, method or
  // material, so no retrieval system could know what is being asked.
  if (!lift.rare) { rejected.push({ ...g, why: 'names nothing specific (no rare term)' }); continue; }
  if (g.question.length < 25) { rejected.push({ ...g, why: 'question too short' }); continue; }
  if (g.expectedAnswer.length < 15) { rejected.push({ ...g, why: 'answer too short' }); continue; }
  // Whitespace-insensitive: the excerpt carries PDF line breaks the model silently
  // normalises when it copies, and rejecting on that would throw away sound questions.
  const flat = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  if (g.supportQuote && !flat(g.windowText).includes(flat(g.supportQuote).slice(0, 60))) {
    rejected.push({ ...g, why: 'support quote not in the window (answer unverified)' }); continue;
  }
  if (resolved.length) { rejected.push({ ...g, why: `names a document (${resolved.length})` }); continue; }
  // The bias this file exists to remove is mechanical: a question that reuses its
  // source's rare terms is handed that source back by BM25. Gate on the question's
  // own wording — never on whether retrieval succeeded, which is the thing measured.
  if (ov >= 6) { rejected.push({ ...g, why: `lifted ${ov} rare terms from the source` }); continue; }
  kept.push({ ...g, overlap: ov, rareTerms: lift.rare, liftedTerms: lift.terms });
}

// The threshold above is a guess until there is a distribution to read it off. Print it.
const dist = new Map();
for (const g of [...kept, ...rejected]) {
  const l = lifted(g.question, g.windowText).shared;
  dist.set(l, (dist.get(l) || 0) + 1);
}
say(`\nrare terms lifted from the source window (df<=${RARE_DF}), all generated questions:`);
for (const k of [...dist.keys()].sort((a, b) => a - b)) say(`  ${String(k).padStart(2)} shared : ${dist.get(k)}`);

say(`\nfairness pass: ${kept.length} kept, ${rejected.length} rejected`);
const byWhy = new Map();
for (const r of rejected) byWhy.set(r.why.replace(/\(.*\)/, ''), (byWhy.get(r.why.replace(/\(.*\)/, '')) || 0) + 1);
for (const [why, n] of [...byWhy].sort((a, b) => b[1] - a[1])) say(`  rejected, ${why}: ${n}`);

// ---------------------------------------------------------------------------
// Strata — MEASURED, never filtered on
// ---------------------------------------------------------------------------

const EMBED_MODEL = process.env.CLIENT_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L12-v2';
say(`\nloading ${EMBED_MODEL} for the reachability measurement ...`);
const extractor = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
const embed = async (t) =>
  Array.from((await extractor([t], { pooling: 'mean', normalize: true })).data);

const TOP_K = 10;
const final = [];
for (const [i, q] of kept.entries()) {
  const emb = await embed(q.question);
  const got = await retrieve(collection, emb, q.question, { topK: TOP_K });
  const { facts, seeds } = await retrieveFacts(collection, q.question);

  const gotDocs = new Set(got.map((c) => c.docId));
  const gotChunks = new Set(got.map((c) => c.chunkId));
  const factDocs = new Set(facts.flatMap((f) => f.docIds ?? []));
  const docIds = q.docIds ?? [q.docId];

  final.push({
    ...q,
    // ALL, not ANY: a cross-document question is only reachable if retrieval brings
    // back every document its answer needs. Reaching one of two is still a failure.
    chunkReachDoc:   docIds.every((d) => gotDocs.has(d)),
    chunkReachAny:   docIds.some((d) => gotDocs.has(d)),
    // The stricter test: did it reach one of the very chunks that carry the answer?
    chunkReachChunk: q.chunkIds.some((c) => gotChunks.has(c)),
    // Does the graph engage at all, and does it reach the support documents?
    graphSeeds:      seeds,
    graphFactCount:  facts.length,
    graphReachDoc:   docIds.every((d) => factDocs.has(d)),
    graphReachAny:   docIds.some((d) => factDocs.has(d)),
  });
  if ((i + 1) % 25 === 0) say(`  measured ${i + 1}/${kept.length}`);
}

const n = final.length;
const pct = (k) => `${((k / n) * 100).toFixed(1)}%`;
const count = (f) => final.filter(f).length;
say(`\n${'='.repeat(64)}`);
say(`questions                                  : ${n}`);
say(`chunk retrieval reaches the support DOC    : ${count((q) => q.chunkReachDoc)}  ${pct(count((q) => q.chunkReachDoc))}`);
say(`chunk retrieval reaches the support CHUNK  : ${count((q) => q.chunkReachChunk)}  ${pct(count((q) => q.chunkReachChunk))}`);
say(`graph engages at all (>=1 seed)            : ${count((q) => q.graphFactCount > 0)}  ${pct(count((q) => q.graphFactCount > 0))}`);
say(`graph reaches the support doc              : ${count((q) => q.graphReachDoc)}  ${pct(count((q) => q.graphReachDoc))}`);
say(`${'-'.repeat(64)}`);
say(`GRAPH-ONLY stratum (graph yes, chunks no)  : ${count((q) => q.graphReachDoc && !q.chunkReachDoc)}  ${pct(count((q) => q.graphReachDoc && !q.chunkReachDoc))}`);
say(`CHUNK-ONLY stratum (chunks yes, graph no)  : ${count((q) => !q.graphReachDoc && q.chunkReachDoc)}  ${pct(count((q) => !q.graphReachDoc && q.chunkReachDoc))}`);
say(`BOTH reach                                 : ${count((q) => q.graphReachDoc && q.chunkReachDoc)}  ${pct(count((q) => q.graphReachDoc && q.chunkReachDoc))}`);
say(`NEITHER reaches                            : ${count((q) => !q.graphReachDoc && !q.chunkReachDoc)}  ${pct(count((q) => !q.graphReachDoc && !q.chunkReachDoc))}`);
say(`mean rare terms lifted from the source      : ${(final.reduce((a, q) => a + q.overlap, 0) / n).toFixed(2)}`);
say(`single-doc / cross-doc                     : ${count((q) => q.mode === 'single')} / ${count((q) => q.mode === 'pair')}`);
for (const mode of ['single', 'pair']) {
  const sub = final.filter((q) => q.mode === mode);
  if (!sub.length) continue;
  const p = (f) => `${((sub.filter(f).length / sub.length) * 100).toFixed(1)}%`;
  say(`  ${mode.padEnd(7)} n=${String(sub.length).padStart(3)}  chunks reach ${p((q) => q.chunkReachDoc)}`
    + `  graph reaches ${p((q) => q.graphReachDoc)}  graph engages ${p((q) => q.graphFactCount > 0)}`);
}
say(`${'='.repeat(64)}`);

if (!flags.emit) {
  say('\nreport only — pass --emit to write questions.v2.json and evidence.v2.json');
  await prisma.$disconnect();
  process.exit(0);
}

const questions = final.map((q, i) => ({
  id: `V${String(i + 1).padStart(3, '0')}`,
  question: q.question,
  expectedAnswer: q.expectedAnswer,
}));
const evidence = Object.fromEntries(final.map((q, i) => [`V${String(i + 1).padStart(3, '0')}`, {
  source: { mode: q.mode, docIds: q.docIds ?? [q.docId], title: q.title, pages: q.pages },
  supportDocIds: q.docIds ?? [q.docId],
  supportChunkIds: q.chunkIds,
  // Hard cap, not a request. The prompt asks for <=300 chars and the model overshoots;
  // this repository is public and the corpus is third-party, so the limit is enforced
  // here rather than trusted to the generator.
  supportQuote: String(q.supportQuote ?? '').slice(0, 300),
  lexicalOverlap: Number(q.overlap.toFixed(3)),
  strata: {
    chunkReachDoc: q.chunkReachDoc,
    chunkReachAny: q.chunkReachAny,
    chunkReachChunk: q.chunkReachChunk,
    graphEngages: q.graphFactCount > 0,
    graphReachDoc: q.graphReachDoc,
    graphReachAny: q.graphReachAny,
    graphSeeds: q.graphSeeds,
  },
}]));

await fs.writeFile(OUT_Q, `${JSON.stringify(questions, null, 1)}\n`);
await fs.writeFile(OUT_EVID, `${JSON.stringify(evidence, null, 1)}\n`);
say(`\nwrote ${OUT_Q} (${questions.length})`);
say(`wrote ${OUT_EVID}`);
await prisma.$disconnect();
