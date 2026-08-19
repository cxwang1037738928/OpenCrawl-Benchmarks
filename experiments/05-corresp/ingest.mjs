/**
 * ingest.mjs — create the topaz collection, upload the letters, run the indexing stages.
 *
 * Drives the real HTTP API rather than writing rows directly. That matters here: a document
 * that arrives through POST /documents goes through inspectPdf, sha256 de-duplication and the
 * same docling extraction a real upload gets. Inserting rows would skip all of it and the
 * corpus would differ from anything the product actually produces.
 *
 * Auth: the API is behind requireAuth, which accepts a JWT signed with the backend's own
 * JWT_SECRET. Rather than needing anyone's password, this mints a token for an existing user
 * with the same secret and algorithm the middleware verifies. The secret is read from the
 * sibling repo's .env in-process and is never written anywhere.
 *
 * Uploads are batched because 221 files in one multipart request would buffer ~12 MB in memory
 * (multer.memoryStorage) and hold a single request open through every docling call.
 *
 * Run:  node ingest.mjs [--name "..."] [--batch 15] [--skip-pipeline]
 *   --dry-run   report what would be uploaded, change nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');
const CORPUS = path.join(HERE, 'corpus');
const API = process.env.API_BASE ?? 'http://localhost:3000/api';

const { values: flags } = parseArgs({
  options: {
    name: { type: 'string', default: 'Experiment 05 — SEC correspondence (A: no graph)' },
    batch: { type: 'string', default: '15' },
    'skip-pipeline': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------- credentials
// dotenv is resolved from the sibling repo so this repo needs no copy of its .env.
const require = createRequire(path.join(OPENCRAWL, 'package.json'));
const dotenv = require('dotenv');
const env = dotenv.parse(fs.readFileSync(path.join(OPENCRAWL, '.env'), 'utf8'));
const JWT_SECRET = env.JWT_SECRET || process.env.JWT_SECRET || 'opencrawl-local-dev-secret';
const jwt = require('jsonwebtoken');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL ?? process.env.DATABASE_URL } },
});

const user = await prisma.user.findFirst({ orderBy: { id: 'asc' } });
if (!user) {
  console.error('no user in the database — register one in the app first');
  process.exit(1);
}
const token = jwt.sign(
  { sub: user.id, email: user.email, isAdmin: !!user.isAdmin },
  JWT_SECRET,
  { expiresIn: '2h' },
);
const auth = { Authorization: `Bearer ${token}` };
console.log(`authenticated as ${user.email} (id ${user.id})`);

// ---------------------------------------------------------------- helpers
// fetch() is undici, which aborts a request whose response headers take longer than 5 minutes.
// POST /pipeline/run holds its connection open for the whole indexing run -- docling on 221 PDFs
// is far longer than that -- so the default killed the client mid-run. The server carried on,
// because an Express handler is not cancelled when its socket drops, which made the failure
// worse than useless: it looked like the run had died while it was in fact still going, and the
// obvious reaction (retry) would have started a second pass over the same collection.
//
// undici's Agent is not requireable (node bundles it privately), so the long calls go through
// node:http instead, whose client sets no header timeout at all. There is no honest upper bound
// to pick for a corpus-sized docling run, so the right number is "none".
async function longPost(pathname, payload) {
  const http = await import('node:http');
  const body = JSON.stringify(payload ?? {});
  const url = new URL(`${API}${pathname}`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) },
      timeout: 0,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
        if (res.statusCode >= 400) {
          reject(new Error(`POST ${pathname} -> ${res.statusCode} ${text.slice(0, 300)}`));
        } else resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { ...auth, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status} ` +
      `${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.pdf')).sort();
if (!files.length) {
  console.error(`no PDFs in ${CORPUS} — run build_corpus.py first`);
  process.exit(1);
}
const totalMb = files.reduce((n, f) => n + fs.statSync(path.join(CORPUS, f)).size, 0) / 1e6;
console.log(`corpus: ${files.length} PDFs, ${totalMb.toFixed(1)} MB`);

// Every letter that backs a gold answer must survive ingestion; a silent upload failure there
// would show up later as "retrieval never reached the support document", which reads like a
// finding rather than a missing file.
const evidence = JSON.parse(fs.readFileSync(path.join(HERE, 'evidence.json'), 'utf8'));
const required = new Set(Object.values(evidence).flatMap((e) => e.supportDocIds));
console.log(`of those, ${required.size} back a gold answer; ${files.length - required.size} are distractors`);

if (flags['dry-run']) {
  console.log('\ndry run — nothing created');
  await prisma.$disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------- collection
const created = await api('/collections', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: flags.name, crawler: 'topaz' }),
});
const collection = created.collection ?? created;
console.log(`\ncollection ${collection.id} created  (crawler=${collection.crawler})`);

// ---------------------------------------------------------------- upload
const batchSize = Number(flags.batch);
let ok = 0;
const failures = [];
for (let i = 0; i < files.length; i += batchSize) {
  const batch = files.slice(i, i + batchSize);
  const form = new FormData();
  for (const name of batch) {
    const buf = fs.readFileSync(path.join(CORPUS, name));
    form.append('files', new Blob([buf], { type: 'application/pdf' }), name);
  }
  const res = await api(`/collections/${collection.id}/documents`, { method: 'POST', body: form });
  for (const r of res.results ?? res.documents ?? []) {
    if (r.ok === false) failures.push(`${r.filename}: ${r.error}`);
    else ok += 1;
  }
  process.stdout.write(`  uploaded ${Math.min(i + batchSize, files.length)}/${files.length}\r`);
}
console.log(`\nuploaded ok: ${ok}   failed: ${failures.length}`);
for (const f of failures.slice(0, 10)) console.log(`  ! ${f}`);

const docs = await api(`/collections/${collection.id}/documents`);
const stems = new Set((docs.documents ?? docs).map((d) => path.parse(d.filename).name));
const missing = [...required].filter((r) => !stems.has(r));
console.log(`documents in collection: ${stems.size}`);
if (missing.length) {
  console.error(`\nMISSING ${missing.length} letters that back gold answers:`);
  for (const m of missing.slice(0, 10)) console.error(`  ${m}`);
  console.error('fix these before running the benchmark — they would read as retrieval misses');
}

// ---------------------------------------------------------------- index
if (!flags['skip-pipeline']) {
  console.log('\nrunning indexing stages (extract, embed, categorize, heuristic)...');
  const t0 = Date.now();
  const out = await longPost(`/collections/${collection.id}/pipeline/run`, {});
  console.log(`finished in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  for (const [stage, r] of Object.entries(out.stages ?? {})) {
    console.log(`  ${stage.padEnd(12)} ${r.ok ? 'ok' : 'FAILED: ' + r.error}`);
  }
}

console.log(`\ncollection id ${collection.id} — pass this to clone_collection.js`);
await prisma.$disconnect();
