/**
 * synthesis_benchmark.js — the paired knowledge-graph run for Synthesis benchmark/
 *
 * Asks the same 200 questions of two collections that differ ONLY in whether they carry
 * a knowledge graph, and records both answers. A separate entry point from main.js
 * because that harness is built around study -> target-document, which does not apply
 * here: these questions name methods, not documents, and most of them need several
 * documents at once.
 *
 * Why the full HTTP path rather than retrieve(): the graph reaches the model through
 * answer(), not through chunk retrieval — retrieveFacts() supplies triples that go into
 * a separate prompt block. Retrieval is bit-identical between the two arms by
 * construction (clone_collection.js), so a retrieval-only run would measure nothing.
 *
 * Per question it records, beyond the reply and its sources:
 *   - supportDocsRetrieved: how many of the question's own support documents actually
 *     reached the model. Without it a wrong answer caused by retrieval is
 *     indistinguishable from one caused by synthesis.
 *   - graph seeds and facts, from retrieveFacts() called in-process. graphFacts is pure,
 *     so the same query against the same collection yields exactly what the server used.
 *     The absence of this diagnostic is why the previous null ablation took a day to
 *     explain.
 *
 * Failures: 429/500/502/503 are retried 3x with 5s/15s/45s backoff; 4xx fails at once.
 * A question that still fails in EITHER arm is re-asked in BOTH arms in a final
 * reconciliation pass, so every pair compared came from the same round.
 *
 * Run:  node synthesis_benchmark.js
 *   --collections 26,33   the two arms, graph arm first   (default 26,33)
 *   --limit <n>           only the first n questions      (smoke tests)
 *   --ids Q001,Q005       only these question ids
 *   --delay <ms>          pause between questions         (default 3000)
 *   --dry-run             preflight only, then exit
 *
 * Env: OPENCRAWL_DIR, BASE_URL, EMAIL, PASSWORD, DELAY_MS.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pipeline } from '@xenova/transformers';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.join(ROOT, 'experiments', '03-synthesis');
const QUESTIONS_PATH = path.join(BENCH_DIR, 'questions.json');
const EVIDENCE_PATH  = path.join(BENCH_DIR, 'evidence.json');

const { values: flags } = parseArgs({
  options: {
    collections: { type: 'string' },
    limit:       { type: 'string' },
    ids:         { type: 'string' },
    delay:       { type: 'string' },
    'dry-run':   { type: 'boolean', default: false },
  },
});

const OPENCRAWL = process.env.OPENCRAWL_DIR || path.resolve(ROOT, '..', 'OpenCrawl');
const ARMS      = (flags.collections ?? '26,33').split(',').map((id) => Number(id.trim()));
const LIMIT     = flags.limit ? Number(flags.limit) : null;
const ID_FILTER = flags.ids ? new Set(flags.ids.split(',').map((id) => id.trim())) : null;
const BASE      = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL     = process.env.EMAIL    || 'demo@gmail.com';
const PASSWORD  = process.env.PASSWORD || 'demo123';
const DELAY_MS  = Number(flags.delay ?? process.env.DELAY_MS ?? 3000);
const EMBED_MODEL = process.env.CLIENT_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L12-v2';

// Transient by nature: a rate limit or a provider hiccup, not a bad request.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [5000, 15000, 45000];

const STAMP = new Date().toISOString().replace(/\..+$/, 'Z').replace(/:/g, '-');
const WIDTH = 96;
const LOG = '[synthesis]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { console.error(`${LOG} ${message}`); process.exit(1); };

async function api(token, method, route, body) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Sibling repo — imported for retrieveFacts only; answering goes over HTTP
// ---------------------------------------------------------------------------

const sibling = (...parts) => pathToFileURL(path.join(OPENCRAWL, ...parts)).href;

try {
  await fs.access(path.join(OPENCRAWL, 'backend', 'retriever', 'retriever.js'));
} catch {
  fail(`no OpenCrawl checkout at ${OPENCRAWL} — set OPENCRAWL_DIR to its path`);
}
createRequire(path.join(OPENCRAWL, 'package.json'))('dotenv')
  .config({ path: path.join(OPENCRAWL, '.env') });
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set');

const { retrieveFacts } = await import(sibling('backend', 'retriever', 'retriever.js'));
const { prisma }        = await import(sibling('backend', 'db.js'));

// ---------------------------------------------------------------------------
// Embedding — same model, pooling and normalization the corpus was built with
// ---------------------------------------------------------------------------

let _extractor = null;
async function embedText(text) {
  if (!_extractor) {
    console.log(`${LOG} loading ${EMBED_MODEL} ...`);
    _extractor = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
  }
  const output = await _extractor([text], { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ---------------------------------------------------------------------------
// .txt rendering
// ---------------------------------------------------------------------------

const GUTTER = ' '.repeat(11);

function block(label, text) {
  const lines = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let line = '';
    for (const word of words) {
      if (line && `${line} ${word}`.length > WIDTH - GUTTER.length) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  if (!lines.length) lines.push('');
  return lines
    .map((line, idx) => (idx === 0 ? `${label.padEnd(9)}: ${line}` : `${GUTTER}${line}`.trimEnd()))
    .join('\n');
}

const listBlock = (label, lines) => (lines.length
  ? lines.map((line, idx) => (idx === 0 ? `${label.padEnd(9)}: ${line}` : `${GUTTER}${line}`)).join('\n')
  : `${label.padEnd(9)}: (none)`);

const pageRange = (pages) => {
  const [first, last] = Array.isArray(pages) ? pages : [];
  if (first == null) return 'p.?';
  return first === last ? `p.${first}` : `p.${first}-${last}`;
};

/** "*" marks a source from one of the question's own support documents. */
const sourceLines = (sources, supportDocIds) => sources.map((source, idx) =>
  `[${idx + 1}]${supportDocIds.includes(source.docId) ? '*' : ' '} ${source.filename}  `
  + `${pageRange(source.pages)}  score ${Number(source.score).toFixed(4)}`);

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const questions = JSON.parse(await fs.readFile(QUESTIONS_PATH, 'utf-8'));
const evidence  = JSON.parse(await fs.readFile(EVIDENCE_PATH, 'utf-8'));

let plan = questions.filter((question) => !ID_FILTER || ID_FILTER.has(question.id));
if (LIMIT) plan = plan.slice(0, LIMIT);
if (!plan.length) fail('no questions selected');

const login = await api(null, 'POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
  .catch((err) => fail(`cannot reach ${BASE} — is the backend running? (${err.message})`));
if (login.status !== 200 || !login.body.token) {
  fail(`login as ${EMAIL} failed: ${login.status} ${login.body.error ?? ''}`);
}
const token = login.body.token;

const visible = (await api(token, 'GET', '/api/collections')).body.collections ?? [];
for (const id of ARMS) {
  if (!visible.some((entry) => entry.id === id)) fail(`collection ${id} is not visible to ${EMAIL}`);
}
const reasoningModel = (await api(token, 'GET', '/api/corpus/models')).body.roles?.REASONING_MODEL;
if (!reasoningModel) fail('REASONING_MODEL is not set on the server — pick one in the Models tab');

// Collection rows for the in-process fact lookup.
const collections = new Map();
for (const id of ARMS) {
  const row = await prisma.collection.findUnique({
    where: { id },
    select: { id: true, name: true, corpusUpdatedAt: true, categories: true,
              embeddingsMeta: true, knowledgeGraph: true },
  });
  if (!row) fail(`no collection ${id} in the database`);
  collections.set(id, row);
  const chunks = await prisma.chunk.count({ where: { collectionId: id } });
  console.log(`${LOG} arm ${id} "${row.name}" — ${chunks} chunks, `
    + `graph ${row.knowledgeGraph ? `${row.knowledgeGraph.entities?.length} entities` : 'NONE'}`);
}

console.log(`${LOG} ${plan.length} questions x ${ARMS.length} arms = ${plan.length * ARMS.length} calls`);
console.log(`${LOG} model ${reasoningModel}, ${DELAY_MS} ms between questions`);

if (flags['dry-run']) {
  console.log(`${LOG} dry run — nothing asked`);
  await prisma.$disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/** Cached per question: the query vector is the same in both arms. */
const vectorCache = new Map();
async function vectorFor(question) {
  if (!vectorCache.has(question.id)) vectorCache.set(question.id, await embedText(question.question));
  return vectorCache.get(question.id);
}

/**
 * One question against one arm, with backoff on transient failures.
 * Returns a record; `error` is non-null only when every attempt failed.
 */
async function ask(collectionId, question) {
  const support = evidence[question.id]?.supportDocIds ?? [];
  const queryEmbedding = await vectorFor(question);
  const collection = collections.get(collectionId);

  // Graph facts, computed here rather than read from the response: the API does not
  // return them, and graphFacts is a pure function of (query, collection).
  const { facts, seeds } = await retrieveFacts(collection, question.question);

  const attempts = [];
  const startedAt = Date.now();
  let reply = null, model = null, sources = [], chatId = null, error = null;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const chat = await api(token, 'POST', '/api/chats', { collectionId });
      if (chat.status !== 201) {
        const err = new Error(`POST /api/chats ${chat.status}: ${chat.body.error ?? ''}`);
        err.status = chat.status;
        throw err;
      }
      chatId = chat.body.chat.id;

      const answered = await api(token, 'POST', `/api/chats/${chatId}/chat`,
        { content: question.question, queryEmbedding });
      if (answered.status !== 200) {
        const err = new Error(`HTTP ${answered.status}: ${answered.body.error ?? ''}`);
        err.status = answered.status;
        throw err;
      }
      reply   = answered.body.reply;
      model   = answered.body.model;
      sources = answered.body.sources ?? [];
      error   = null;
      break;
    } catch (err) {
      attempts.push(err.message);
      error = err.message;
      if (chatId) { await api(token, 'DELETE', `/api/chats/${chatId}`).catch(() => {}); chatId = null; }
      const retryable = RETRY_STATUSES.has(err.status);
      if (!retryable || attempt === BACKOFF_MS.length) break;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  const latencyMs = Date.now() - startedAt;
  if (chatId) await api(token, 'DELETE', `/api/chats/${chatId}`).catch(() => {});

  const retrievedDocIds = [...new Set(sources.map((source) => source.docId))];
  return {
    id: question.id,
    type: question.type,
    collectionId,
    question: question.question,
    expected: question.expectedAnswer,
    reply, model, chatId,
    sources,
    supportDocIds: support,
    supportDocsRetrieved: support.filter((docId) => retrievedDocIds.includes(docId)).length,
    supportDocCount: support.length,
    docsRetrieved: retrievedDocIds.length,
    graphSeeds: seeds,
    graphFactCount: facts.length,
    graphFacts: facts.map((fact) => `${fact.subject} ${fact.predicate} ${fact.object}`),
    // [G] is the model's own marker that a claim rests on a graph fact.
    citedGraph: typeof reply === 'string' && reply.includes('[G]'),
    attempts: attempts.length + (error ? 0 : 1),
    attemptErrors: attempts,
    latencyMs,
    error,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const files = new Map();
// New runs land in runs/; the ones a report cites get promoted into the matching
// experiments/<nn>-<name>/ folder, so the repository root stays clean.
const RUNS_DIR = path.join(ROOT, 'runs');
await fs.mkdir(RUNS_DIR, { recursive: true });
for (const id of ARMS) {
  const row = collections.get(id);
  const txt  = path.join(RUNS_DIR, `synthesis_c${id}_${STAMP}.txt`);
  const json = path.join(RUNS_DIR, `synthesis_c${id}_${STAMP}.jsonl`);
  files.set(id, { txt, json });
  await fs.writeFile(txt, [
    '='.repeat(WIDTH),
    `Synthesis benchmark — ${new Date().toISOString().replace('T', ' ').replace(/\..+$/, ' UTC')}`,
    '-'.repeat(WIDTH),
    `collection      : ${id} "${row.name}"`,
    `knowledge graph : ${row.knowledgeGraph
      ? `${row.knowledgeGraph.entities?.length} entities / ${row.knowledgeGraph.relations?.length} relations`
      : 'NONE — this is the control arm'}`,
    `reasoning model : ${reasoningModel}`,
    `embedding model : ${EMBED_MODEL} (quantized, mean pooling, L2-normalized)`,
    `questions       : ${plan.length}`,
    `pacing          : ${DELAY_MS} ms, retries on ${[...RETRY_STATUSES].join('/')} with `
      + `${BACKOFF_MS.map((ms) => ms / 1000).join('/')}s backoff`,
    `legend          : "*" marks a source from one of the question's own support documents`,
    '='.repeat(WIDTH), '', '',
  ].join('\n'), 'utf-8');
}

async function record(result) {
  const { txt, json } = files.get(result.collectionId);
  const head = `[${result.id} ${result.type}]  ${(result.latencyMs / 1000).toFixed(1)}s`
    + `  ${result.supportDocsRetrieved}/${result.supportDocCount} support docs retrieved`
    + `  graph ${result.graphFactCount} facts${result.citedGraph ? ' [G] cited' : ''}`
    + (result.attempts > 1 ? `  (${result.attempts} attempts)` : '');
  const body = [
    head,
    block('QUESTION', result.question),
    block('EXPECTED', result.expected),
    ...(result.error ? [block('ERROR', result.error)] : [
      block('ANSWER', result.reply),
      listBlock('SOURCES', sourceLines(result.sources, result.supportDocIds)),
      block('SEEDS', result.graphSeeds.join(', ') || '(none)'),
    ]),
    '',
  ].join('\n');
  await fs.appendFile(txt, `${body}\n`, 'utf-8');
  await fs.appendFile(json, `${JSON.stringify(result)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Sweep — arm by arm, then reconcile
// ---------------------------------------------------------------------------

const results = new Map();          // `${armId}:${questionId}` -> result
let asked = 0;
const total = plan.length * ARMS.length;

for (const armId of ARMS) {
  console.log(`\n${LOG} arm ${armId} — ${plan.length} questions`);
  for (const question of plan) {
    const result = await ask(armId, question);
    results.set(`${armId}:${question.id}`, result);
    await record(result);
    asked++;
    const line = `${LOG} ${asked}/${total} c${armId} ${question.id}`
      + (result.error ? ` FAILED (${result.error})` : ` ${(result.latencyMs / 1000).toFixed(1)}s`);
    if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(100)}`);
    else console.log(line);
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
}
console.log('');

// A question that failed in either arm is re-asked in BOTH, so the pair being compared
// always comes from the same round rather than one fresh answer against one stale one.
const broken = plan.filter((question) =>
  ARMS.some((armId) => results.get(`${armId}:${question.id}`)?.error));
if (broken.length) {
  console.log(`\n${LOG} reconciliation: ${broken.length} question(s) failed in at least one arm`);
  for (const question of broken) {
    for (const armId of ARMS) {
      const result = await ask(armId, question);
      results.set(`${armId}:${question.id}`, result);
      await record({ ...result, id: `${result.id} (re-asked)` });
      console.log(`${LOG}   c${armId} ${question.id} ${result.error ? `STILL FAILING (${result.error})` : 'ok'}`);
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(WIDTH)}`);
for (const armId of ARMS) {
  const arm = plan.map((question) => results.get(`${armId}:${question.id}`));
  const ok = arm.filter((result) => !result.error);
  const supportHit = ok.reduce((sum, result) => sum + result.supportDocsRetrieved, 0);
  const supportTotal = ok.reduce((sum, result) => sum + result.supportDocCount, 0);
  console.log(`arm ${armId} "${collections.get(armId).name}"`);
  console.log(`  answered            : ${ok.length}/${arm.length}`);
  console.log(`  graph facts supplied: ${ok.filter((result) => result.graphFactCount > 0).length}/${ok.length}`);
  console.log(`  answers citing [G]  : ${ok.filter((result) => result.citedGraph).length}/${ok.length}`);
  console.log(`  support docs reached: ${supportHit}/${supportTotal} `
    + `(${(100 * supportHit / (supportTotal || 1)).toFixed(1)}%)`);
  console.log(`  -> ${path.basename(files.get(armId).txt)}`);
}

// Questions where the two arms disagree on whether the answer is even present are the
// ones worth reading first when grading.
if (ARMS.length === 2) {
  const [a, b] = ARMS;
  const differing = plan.filter((question) => {
    const ra = results.get(`${a}:${question.id}`);
    const rb = results.get(`${b}:${question.id}`);
    return ra?.reply && rb?.reply && ra.reply.trim() !== rb.reply.trim();
  });
  console.log(`\nreplies differing verbatim between the arms: ${differing.length}/${plan.length}`);
}

await prisma.$disconnect();
