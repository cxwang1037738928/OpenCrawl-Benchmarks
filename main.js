/**
 * main.js — records what OpenCrawl's retriever fetches for every benchmark
 * question in documents/benchmark_questions/questions.json. No LLM is called.
 *
 * 20 studies x 11 prompts = 220 questions, each embedded and sent through the
 * real retriever as
 *   "regarding <study>, answer the following: <prompt>"
 * The output is the ranked chunk list per question — filename, pages, chunkId
 * and the full score breakdown (sim / boost / lex / score) — with the chunks
 * belonging to the study actually being asked about marked.
 *
 * Why it bypasses HTTP: POST /api/chats/:id/chat always synthesizes an answer,
 * so there is no way to observe retrieval alone through the API. retrieve() in
 * ../OpenCrawl/backend/retriever/retriever.js is exported and self-sufficient —
 * given a Collection row and a query vector it loads the chunks from Postgres,
 * scores them, and returns the ranking. Importing it measures the real thing
 * rather than a reimplementation that would drift the moment retrieval is tuned.
 * That means this script needs the sibling repo on disk and a reachable
 * DATABASE_URL, but no running server and no model credentials.
 *
 * The query vector still comes from this repo's own copy of MiniLM, with the
 * pooling and normalization the corpus was built with — a different model is a
 * different vector space and retrieves badly without ever erroring.
 *
 * Run:  node main.js
 *   --collection <id>   collection to query          (default 28)
 *   --top-k <n>         chunks per question          (default RETRIEVER_TOP_K)
 *   --studies 1.1,2.4   only these studies (numeric id, or substring of the name)
 *   --limit <n>         only the first n prompts of each study
 *   --dry-run           preflight + study/document match table, then exit
 *   --target-doc        scope retrieval to the study's own document, instead of
 *                       letting the retriever resolve it from the question text.
 *                       Retrieves min(top-k, chunks in that document) chunks.
 *   --answers           ask the LLM too: drives POST /api/chats/:id/chat over
 *                       HTTP and records the reply alongside its sources, in
 *                       benchmark_<stamp>.txt/.jsonl. Needs a running backend
 *                       and a REASONING_MODEL, and costs one model call per
 *                       question. Without it nothing but the retriever runs.
 *   --delay <ms>        pause between questions in --answers mode (default 3000)
 *
 * Env overrides: OPENCRAWL_DIR, COLLECTION_ID, DATABASE_URL, BASE_URL, EMAIL,
 * PASSWORD, DELAY_MS.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pipeline } from '@xenova/transformers';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUESTIONS_PATH = path.join(ROOT, 'documents', 'benchmark_questions', 'questions.json');

// ---------------------------------------------------------------------------
// Configuration — constants, overridden by env vars, overridden by flags
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    collection: { type: 'string' },
    'top-k':    { type: 'string' },
    studies:    { type: 'string' },
    limit:      { type: 'string' },
    'dry-run':  { type: 'boolean', default: false },
    'target-doc': { type: 'boolean', default: false },
    answers:    { type: 'boolean', default: false },
    delay:      { type: 'string' },
  },
});

const OPENCRAWL     = process.env.OPENCRAWL_DIR || path.resolve(ROOT, '..', 'OpenCrawl');
const COLLECTION_ID = Number(flags.collection ?? process.env.COLLECTION_ID ?? 28);
const PROMPT_LIMIT  = flags.limit ? Number(flags.limit) : null;
const STUDY_FILTER  = flags.studies
  ? flags.studies.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean)
  : null;

// Answer mode drives the HTTP API instead of calling retrieve() in-process, so
// the run exercises the same path a user does — retrieval, synthesis and all.
const ANSWERS  = flags.answers;
const BASE     = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL    = process.env.EMAIL    || 'demo@gmail.com';
const PASSWORD = process.env.PASSWORD || 'demo123';
// 3 s between questions keeps a hosted reasoning model under ~15 requests/min;
// there are no retries, so a rate-limit burst would lose answers outright.
const DELAY_MS = Number(flags.delay ?? process.env.DELAY_MS ?? 3000);

const EMBED_MODEL = process.env.CLIENT_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L12-v2';

const STAMP     = new Date().toISOString().replace(/\..+$/, 'Z').replace(/:/g, '-');
const PREFIX    = ANSWERS ? 'benchmark' : 'retrieval';
// New runs land in runs/; the ones a report actually cites get promoted into the
// matching experiments/<nn>-<name>/ folder, so the root stays clean.
const RUNS_DIR  = path.join(ROOT, 'runs');
fsSync.mkdirSync(RUNS_DIR, { recursive: true });
const TXT_PATH  = path.join(RUNS_DIR, `${PREFIX}_${STAMP}.txt`);
const JSON_PATH = path.join(RUNS_DIR, `${PREFIX}_${STAMP}.jsonl`);

const WIDTH  = ANSWERS ? 78 : 110;  // chunk rows are tabular; prose wraps narrower
const GUTTER = ' '.repeat(11);      // aligns continuation lines under "PROMPT   : "
const LOG    = ANSWERS ? '[benchmark]' : '[retrieval]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`${LOG} ${message}`);
  process.exit(1);
}

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
// The sibling repo — its modules read env at import time, so .env comes first
// ---------------------------------------------------------------------------

const sibling = (...parts) => pathToFileURL(path.join(OPENCRAWL, ...parts)).href;

try {
  await fs.access(path.join(OPENCRAWL, 'backend', 'retriever', 'retriever.js'));
} catch {
  fail(`no OpenCrawl checkout at ${OPENCRAWL} — set OPENCRAWL_DIR to its path`);
}

// dotenv resolved from the sibling's node_modules; it does not overwrite vars
// already set here, so the shell still wins over the file.
createRequire(path.join(OPENCRAWL, 'package.json'))('dotenv')
  .config({ path: path.join(OPENCRAWL, '.env') });
if (!process.env.DATABASE_URL) fail(`DATABASE_URL is not set (looked in ${path.join(OPENCRAWL, '.env')})`);

// Dynamic, because RETRIEVER_* are read into module constants on first import.
const { retrieve } = await import(sibling('backend', 'retriever', 'retriever.js'));
const { prisma }   = await import(sibling('backend', 'db.js'));

const TOP_K = Number(flags['top-k'] ?? process.env.RETRIEVER_TOP_K ?? 8);

// ---------------------------------------------------------------------------
// Embedding — same model, pooling and normalization as the corpus
// ---------------------------------------------------------------------------

let _extractor = null;

/** Embed one query -> a plain L2-normalized number array (cosine = dot product). */
async function embedText(text) {
  if (!_extractor) {
    console.log(`${LOG} loading ${EMBED_MODEL} ...`);
    _extractor = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
  }
  const output = await _extractor([text], { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ---------------------------------------------------------------------------
// Study names
// ---------------------------------------------------------------------------

// questions.json and the collection disagree about separators and the .pdf
// suffix ("1.2_Inhalation_geno" vs "1.2 Inhalation_geno.pdf"), so compare on a
// flattened form. The prompt itself still carries the study string verbatim.
const normalizeName = (name) =>
  String(name).toLowerCase().replace(/\.pdf$/, '').replace(/[_\s]+/g, ' ').trim();

/** Leading id token: "1.10_Oral_Repd" -> "1.10". */
const studyId = (name) => normalizeName(name).split(' ')[0];

/** A --studies token matches by exact id, or by substring once it contains letters. */
const matchesFilter = (study) => !STUDY_FILTER || STUDY_FILTER.some((token) =>
  (/[a-z]/.test(token) ? normalizeName(study).includes(token) : studyId(study) === token));

/** study -> the collection document it is about, or null. */
function matchDocument(study, documents) {
  const exact = documents.find((doc) => normalizeName(doc.filename) === normalizeName(study));
  if (exact) return exact;
  // Fall back to the numeric id, but only when it is unambiguous.
  const byId = documents.filter((doc) => studyId(doc.filename) === studyId(study));
  return byId.length === 1 ? byId[0] : null;
}

// ---------------------------------------------------------------------------
// .txt rendering
// ---------------------------------------------------------------------------

/** "LABEL    : text", wrapped to WIDTH with continuations under the gutter. */
function block(label, text) {
  const rendered = [];
  for (const paragraph of String(text ?? '').split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { rendered.push(''); continue; }
    let line = '';
    for (const word of words) {
      if (line && `${line} ${word}`.length > WIDTH - GUTTER.length) {
        rendered.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    rendered.push(line);
  }
  if (!rendered.length) rendered.push('');
  return rendered
    .map((line, idx) => (idx === 0 ? `${label.padEnd(9)}: ${line}` : `${GUTTER}${line}`.trimEnd()))
    .join('\n');
}

/** Same gutter, but pre-built lines that must not be re-wrapped. */
function listBlock(label, lines) {
  if (!lines.length) return `${label.padEnd(9)}: (none)`;
  return lines
    .map((line, idx) => (idx === 0 ? `${label.padEnd(9)}: ${line}` : `${GUTTER}${line}`))
    .join('\n');
}

const pageRange = (pages) => {
  const [first, last] = Array.isArray(pages) ? pages : [];
  if (first == null) return 'p.?';
  return first === last ? `p.${first}` : `p.${first}-${last}`;
};

/** Compact citation row for the answer report, where the page is 78 columns. */
function sourceLines(chunks, targetDocId) {
  return chunks.map((chunk, idx) =>
    `[${idx + 1}]${chunk.docId === targetDocId ? '*' : ' '} ${chunk.filename}  `
    + `${pageRange(chunk.pages)}  ${chunk.chunkId}  score ${chunk.score.toFixed(4)}`);
}

/** One tabular row per retrieved chunk; "*" flags a chunk from the target study. */
function chunkLines(chunks, targetDocId) {
  return chunks.map((chunk, idx) => [
    `[${String(idx + 1).padStart(2)}]`,
    (chunk.docId === targetDocId ? '*' : ' '),
    chunk.filename.padEnd(24),
    pageRange(chunk.pages).padEnd(9),
    chunk.chunkId.padEnd(22),
    `score ${chunk.score.toFixed(4)}`,
    `sim ${chunk.sim.toFixed(4)}`,
    `boost ${chunk.boost.toFixed(2)}`,
    `lex ${chunk.lex.toFixed(4)}`,
  ].join(' '));
}

// ---------------------------------------------------------------------------
// Preflight — the collection row retrieve() needs, plus its documents
// ---------------------------------------------------------------------------

if (!Number.isInteger(COLLECTION_ID)) fail(`--collection must be an integer (got "${COLLECTION_ID}")`);

const collection = await prisma.collection.findUnique({
  where:  { id: COLLECTION_ID },
  select: { id: true, name: true, corpusUpdatedAt: true, categories: true, embeddingsMeta: true },
}).catch((err) => fail(`cannot reach Postgres — is it up? (${err.message})`));
if (!collection) fail(`no collection ${COLLECTION_ID} in the database`);

const chunkCount = await prisma.chunk.count({ where: { collectionId: COLLECTION_ID } });
if (!chunkCount) fail(`collection ${COLLECTION_ID} has no indexed chunks — run the embed stage first`);

const docs = await prisma.document.findMany({
  where:   { collectionId: COLLECTION_ID },
  select:  { docId: true, filename: true, status: true },
  orderBy: { createdAt: 'asc' },
});

// Answer mode needs a live server and a reasoning model on top of the database.
// Checked up front: with no retries, an unset model would yield 220 identical
// 503s rather than a benchmark.
let token = null;
let reasoningModel = null;
if (ANSWERS) {
  const login = await api(null, 'POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })
    .catch((err) => fail(`cannot reach ${BASE} — is the backend running? (${err.message})`));
  if (login.status !== 200 || !login.body.token) {
    fail(`login as ${EMAIL} failed: ${login.status} ${login.body.error ?? ''}`);
  }
  token = login.body.token;

  const collections = await api(token, 'GET', '/api/collections');
  if (!(collections.body.collections ?? []).some((entry) => entry.id === COLLECTION_ID)) {
    fail(`collection ${COLLECTION_ID} is not visible to ${EMAIL} over the API`);
  }
  const models = await api(token, 'GET', '/api/corpus/models');
  reasoningModel = models.body.roles?.REASONING_MODEL;
  if (!reasoningModel) fail('REASONING_MODEL is not set on the server — pick one in the Models tab');
}

const questions = JSON.parse(await fs.readFile(QUESTIONS_PATH, 'utf-8'));
const studies = questions.filter((entry) => matchesFilter(entry.study));
if (!studies.length) fail(`--studies "${flags.studies}" matched none of the ${questions.length} studies`);

// Resolve each study to the document it asks about — the whole point of the
// report is whether retrieval reaches that document.
const targets = new Map();
for (const entry of studies) {
  const doc = matchDocument(entry.study, docs);
  targets.set(entry.study, doc);
  if (!doc) console.warn(`${LOG} warning: no document in collection ${COLLECTION_ID} matches "${entry.study}"`);
}

const plan = studies.map((entry) => ({
  study: entry.study,
  prompts: (PROMPT_LIMIT ? entry.prompt.slice(0, PROMPT_LIMIT) : entry.prompt),
  answers: entry['correct answer'] ?? [],
}));
const total = plan.reduce((sum, entry) => sum + entry.prompts.length, 0);

if (flags['dry-run']) {
  console.log(`\ncollection ${collection.id} "${collection.name}" — ${docs.length} documents, ${chunkCount} chunks`);
  for (const entry of plan) {
    const doc = targets.get(entry.study);
    console.log(`  ${entry.study.padEnd(24)} -> ${doc ? `${doc.filename}  (${doc.docId}, ${doc.status})` : 'NO MATCH'}`);
  }
  const unmatched = plan.filter((entry) => !targets.get(entry.study)).length;
  console.log(`\n${total} questions across ${plan.length} studies; ${unmatched} unmatched`);
  await prisma.$disconnect();
  process.exit(unmatched ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

await fs.writeFile(TXT_PATH, [
  '='.repeat(WIDTH),
  `OpenCrawl ${ANSWERS ? 'answer' : 'retrieval'} report`
    + ` — ${new Date().toISOString().replace('T', ' ').replace(/\..+$/, ' UTC')}`,
  '-'.repeat(WIDTH),
  ANSWERS
    ? `source          : ${BASE} (POST /api/chats/:id/chat — full RAG path)`
    : `source          : ${OPENCRAWL} (retrieve() called directly — no server, no LLM)`,
  `collection      : ${collection.id} "${collection.name}" (${docs.length} documents, ${chunkCount} chunks)`,
  ...(ANSWERS ? [`reasoning model : ${reasoningModel}`] : []),
  `embedding model : ${EMBED_MODEL} (quantized, mean pooling, L2-normalized)`,
  `questions       : ${total} across ${plan.length} studies`,
  `top-k           : ${TOP_K}`,
  `retrieval       : doc boost ${process.env.RETRIEVER_DOC_BOOST ?? '2.0'}`
    + `, lexical weight ${process.env.RETRIEVER_LEXICAL_WEIGHT ?? '0.3'}`
    + `, score floor ${process.env.RETRIEVER_SCORE_FLOOR ?? '0.5'}`
    + `, keyword boost ${process.env.RETRIEVER_KEYWORD_BOOST ?? '1.05'}`
    + `, bm25 k1 ${process.env.RETRIEVER_BM25_K1 ?? '1.5'} b ${process.env.RETRIEVER_BM25_B ?? '0.75'}`,
  ...(ANSWERS
    ? [`pacing          : ${DELAY_MS} ms between questions, no retries`,
       `document scope  : ${flags['target-doc'] ? 'explicit docIds (hard filter)' : 'inferred from the question (boost)'}`]
    : [`legend          : "*" marks a chunk from the study the question is about`]),
  '='.repeat(WIDTH),
  '',
  '',
].join('\n'), 'utf-8');

console.log(`${LOG} ${total} questions -> ${path.basename(TXT_PATH)}`);

let asked = 0;
let hitTotal = 0;
let chunkTotal = 0;
let zeroHit = 0;

for (const [studyIdx, entry] of plan.entries()) {
  const target = targets.get(entry.study);
  const heading = `---- [${studyIdx + 1}/${plan.length}] ${entry.study} `;
  await fs.appendFile(TXT_PATH, `${heading}${'-'.repeat(Math.max(0, WIDTH - heading.length))}\n\n`, 'utf-8');

  for (const [promptIdx, rawPrompt] of entry.prompts.entries()) {
    // Prompts 9-11 carry literal <br> tags and long whitespace runs from whatever
    // authored the JSON; they are markup noise to both the embedder and BM25.
    const prompt = rawPrompt.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
    const content = `regarding ${entry.study}, answer the following: ${prompt}`;
    const expected = entry.answers[promptIdx] ?? '(none in questions.json)';
    const label = `[Q ${promptIdx + 1}/${entry.prompts.length}]`;

    const startedAt = Date.now();
    let chunks = [];
    let reply = null;
    let model = null;
    let chatId = null;
    let error = null;
    try {
      const queryEmbedding = await embedText(content);
      // --target-doc scopes retrieval to the document the question is about, so
      // the run measures what perfect targeting looks like; without it the run
      // measures the retriever resolving and boosting the name on its own.
      const scope = flags['target-doc'] && target ? { docIds: [target.docId] } : {};

      if (ANSWERS) {
        // One fresh chat per question: the API resends the whole conversation
        // each turn, so a shared chat would let earlier answers steer later ones.
        const chat = await api(token, 'POST', '/api/chats', { collectionId: COLLECTION_ID });
        if (chat.status !== 201) throw new Error(`POST /api/chats ${chat.status}: ${chat.body.error ?? ''}`);
        chatId = chat.body.chat.id;

        const answered = await api(token, 'POST', `/api/chats/${chatId}/chat`,
          { content, queryEmbedding, ...scope });
        if (answered.status !== 200) throw new Error(`HTTP ${answered.status}: ${answered.body.error ?? ''}`);
        reply = answered.body.reply;
        model = answered.body.model;
        chunks = answered.body.sources ?? [];   // text and embedding already stripped server-side
      } else {
        const retrieved = await retrieve(collection, queryEmbedding, content, { topK: TOP_K, ...scope });
        // The embedding rides along for citation grounding; it is 384 floats of
        // noise in a report and would dwarf the text in the sidecar.
        chunks = retrieved.map(({ embedding, ...chunk }) => chunk);
      }
    } catch (err) {
      error = err.message;
    }
    const latencyMs = Date.now() - startedAt;
    if (chatId) await api(token, 'DELETE', `/api/chats/${chatId}`).catch(() => {});

    const targetHits = target ? chunks.filter((chunk) => chunk.docId === target.docId).length : null;
    const bestTargetRank = target
      ? chunks.findIndex((chunk) => chunk.docId === target.docId) + 1 || null
      : null;
    const unit = ANSWERS ? 'sources' : 'chunks';
    const targetLine = target
      ? `${target.filename} — ${targetHits}/${chunks.length} ${unit} from target`
        + (bestTargetRank ? `, best at rank ${bestTargetRank}` : ', none retrieved')
      : 'unmatched — no document in this collection matches the study name';

    const record = [
      ANSWERS
        ? `${label}  ${chatId ? `chat ${chatId}  ` : ''}${(latencyMs / 1000).toFixed(1)}s`
        : `${label}  ${chunks.length} chunks  ${(latencyMs / 1000).toFixed(2)}s`,
      block('PROMPT', content),
      block('EXPECTED', expected),
      ...(error ? [block('ERROR', error)] : [
        ...(ANSWERS ? [block('ANSWER', reply)] : []),
        block('TARGET', targetLine),
        ANSWERS
          ? listBlock('SOURCES', sourceLines(chunks, target?.docId))
          : listBlock('CHUNKS', chunkLines(chunks, target?.docId)),
      ]),
      '',
    ].join('\n');

    await fs.appendFile(TXT_PATH, `${record}\n`, 'utf-8');
    await fs.appendFile(JSON_PATH, `${JSON.stringify({
      study: entry.study,
      questionIndex: promptIdx,
      targetDocId: target?.docId ?? null,
      targetFilename: target?.filename ?? null,
      content,
      expected,
      topK: TOP_K,
      chunkCount: chunks.length,
      targetHits,
      bestTargetRank,
      latencyMs,
      error,
      // Answer mode keeps the original schema — reply/model/sources/chatId —
      // so a run is directly comparable with the pre-boost benchmark files.
      ...(ANSWERS ? { reply, model, chatId, sources: chunks } : {
        chunks: chunks.map((chunk, idx) => ({
          rank: idx + 1,
          isTarget: target ? chunk.docId === target.docId : null,
          ...chunk,
        })),
      }),
    })}\n`, 'utf-8');

    if (!error) {
      chunkTotal += chunks.length;
      hitTotal += targetHits ?? 0;
      if (targetHits === 0) zeroHit++;
    }
    // Overwrite one line on a terminal; on a pipe or a redirect, one line per study.
    asked++;
    if (process.stdout.isTTY) process.stdout.write(`\r${LOG} ${asked}/${total} ${entry.study.padEnd(24)}`);
    else if (ANSWERS || promptIdx === entry.prompts.length - 1) {
      console.log(`${LOG} ${asked}/${total} ${entry.study} Q${promptIdx + 1}`
        + (error ? ` FAILED (${error})` : ` ${(latencyMs / 1000).toFixed(1)}s`));
    }
    if (ANSWERS && DELAY_MS > 0) await sleep(DELAY_MS);
  }
}

console.log(`\n${LOG} done — ${TXT_PATH}`);
console.log(`${LOG}        ${JSON_PATH}`);
console.log(`${LOG} ${hitTotal}/${chunkTotal} chunks from target `
  + `(${(100 * hitTotal / (chunkTotal || 1)).toFixed(1)}%), `
  + `${zeroHit}/${asked} questions retrieved none (${(100 * zeroHit / (asked || 1)).toFixed(0)}%)`);

await prisma.$disconnect();
