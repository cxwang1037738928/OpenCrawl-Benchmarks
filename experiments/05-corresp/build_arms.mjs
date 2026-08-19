/**
 * build_arms.mjs — clone the indexed corpus into graph arms and build their graphs.
 *
 * The three arms must differ in the graph and in nothing else, so the corpus is cloned row for
 * row rather than re-indexed (clone_collection.js). Two things about that are easy to get wrong
 * and would corrupt the comparison silently rather than loudly:
 *
 * 1. THE CLONE HAS NO HEURISTIC RANKING.
 *    clone_collection.js copies documents, chunks, embeddings, categories and the uploaded PDFs.
 *    It does not copy the per-collection scratch directory, and heuristic_output.json lives
 *    there. kg_graph.py reads that file to decide which documents it graphs from full text --
 *    and when the file is missing, _ranked_doc_ids() returns [] and it falls back to chunk-store
 *    order (kg_graph.py:402-408). No error, no warning: the arm just gets a graph built over an
 *    arbitrary document order, which is not the thing being tested. So the heuristic stage is
 *    re-run on every clone before its graph, and this script refuses to build a graph until it
 *    has seen that stage succeed.
 *
 * 2. THE FULL-TEXT FRACTION IS A PROPERTY OF THE SERVER PROCESS, NOT THE REQUEST.
 *    kg_graph.py reads KG_FULL_TEXT_FRACTION at import (kg_graph.py:193), the subprocess
 *    inherits the backend's environment (spawnAsync passes ...process.env), and POST
 *    /build-graph accepts no parameters. There is therefore no way to ask for a different
 *    fraction per request: the backend must be restarted with the value you want. This script
 *    cannot read the server's environment, so --fraction is a DECLARATION by the operator. It is
 *    recorded in the collection name so an arm can never be misidentified later, but it is not
 *    verified -- get it wrong and you have two arms with the same graph and a different label.
 *
 * The heuristic's ranking depth is decoupled from that env on purpose: rankedK = max(k,
 * ceil(docs * env fraction)), so passing an explicit k of ceil(docs * intended fraction)
 * guarantees a deep enough ranking whatever the server is set to.
 *
 * Run:
 *   node build_arms.mjs clone --from 34 --fraction 0.4
 *   node build_arms.mjs graph --collection <id> --fraction 0.4
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');
const API = process.env.API_BASE ?? 'http://localhost:3000/api';

const cmd = process.argv[2];
const { values: flags } = parseArgs({
  args: process.argv.slice(3),
  options: {
    from: { type: 'string' },
    collection: { type: 'string' },
    fraction: { type: 'string' },
    name: { type: 'string' },
  },
});

const require = createRequire(path.join(OPENCRAWL, 'package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(OPENCRAWL, '.env'), 'utf8'));
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL ?? process.env.DATABASE_URL } },
});

const user = await prisma.user.findFirst({ orderBy: { id: 'asc' } });
const token = jwt.sign({ sub: user.id, email: user.email, isAdmin: !!user.isAdmin },
  env.JWT_SECRET || 'opencrawl-local-dev-secret', { expiresIn: '6h' });

// The graph build runs for hours (an LLM call per packed batch) and the heuristic stage for
// minutes. fetch() is undici, which gives up on a response after 5 minutes of silence and would
// abort the client while the server kept working -- the exact failure that hit the ingest run.
// undici's Agent is not requireable, so long calls use node:http, whose client has no such
// timeout. Short calls (listing collections) keep using fetch.
async function longPost(pathname, payload) {
  const http = await import('node:http');
  const body = JSON.stringify(payload ?? {});
  const url = new URL(`${API}${pathname}`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
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
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} -> ${res.status} ` +
    `${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const fraction = parseFloat(flags.fraction ?? '');
if (!(fraction > 0 && fraction <= 1)) {
  console.error('--fraction must be in (0, 1] — the KG_FULL_TEXT_FRACTION this arm represents');
  process.exit(1);
}

// ---------------------------------------------------------------- clone
if (cmd === 'clone') {
  const from = Number(flags.from);
  if (!from) { console.error('--from <collection id> is required'); process.exit(1); }

  const name = flags.name ?? `Experiment 05 — graph @ KG_FULL_TEXT_FRACTION=${fraction}`;
  console.log(`cloning collection ${from} -> "${name}"`);
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath,
      [path.join(ROOT, 'clone_collection.js'), '--from', String(from), '--name', name,
        '--crawler', 'topaz'],
      { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`clone exited ${code}`))));
  });

  const all = await api('/collections');
  const clone = (all.collections ?? all).filter((c) => c.name === name)
    .sort((a, b) => b.id - a.id)[0];
  if (!clone) { console.error('could not find the clone by name'); process.exit(1); }

  const docs = await prisma.document.count({ where: { collectionId: clone.id } });
  const k = Math.ceil(docs * fraction);
  console.log(`\nclone id ${clone.id}  (${docs} documents)`);
  console.log(`re-running heuristic with k=${k} — the clone has no scratch dir, and kg_graph.py`);
  console.log('falls back to chunk-store order in silence when the ranking is missing');

  const out = await longPost(`/collections/${clone.id}/pipeline/heuristic`, { k });
  const ranked = out.ranking?.length ?? out.topK?.length ?? out.documents?.length;
  console.log(`heuristic ok — ranked ${ranked ?? '(count not reported)'} documents`);
  if (ranked !== undefined && ranked < k) {
    console.error(`WARNING: ranking is shorter than the full-text quota (${ranked} < ${k}); ` +
      'the remainder would be chosen in arbitrary order');
  }
  console.log(`\nnext:  node build_arms.mjs graph --collection ${clone.id} --fraction ${fraction}`);
  await prisma.$disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------- graph
if (cmd === 'graph') {
  const id = Number(flags.collection);
  if (!id) { console.error('--collection <id> is required'); process.exit(1); }

  // The ranking must already be on disk. Building without it is the silent failure this whole
  // script exists to prevent, so it is checked rather than assumed.
  const scratchCandidates = [
    path.join(OPENCRAWL, 'data', 'collections', String(id), 'heuristic_output.json'),
    path.join(OPENCRAWL, 'backend', 'data', String(id), 'heuristic_output.json'),
    path.join(OPENCRAWL, 'data', String(id), 'heuristic_output.json'),
    path.join(OPENCRAWL, '.scratch', String(id), 'heuristic_output.json'),
  ];
  const found = scratchCandidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error('could not find heuristic_output.json for this collection in any of:');
    for (const p of scratchCandidates) console.error(`  ${p}`);
    console.error('\nrun the clone step first (it re-runs the heuristic stage), or pass the');
    console.error('right scratch root — building now would graph in chunk-store order silently');
    process.exit(1);
  }
  const ranked = JSON.parse(fs.readFileSync(found, 'utf8'));
  const n = (ranked.ranking ?? ranked.topK ?? ranked.documents ?? []).length;
  const docs = await prisma.document.count({ where: { collectionId: id } });
  console.log(`ranking found: ${found}`);
  console.log(`ranked ${n} of ${docs} documents; full-text quota at ${fraction} is ` +
    `${Math.ceil(docs * fraction)}`);
  if (n < Math.ceil(docs * fraction)) {
    console.error('\nSTOP: the ranking is shorter than the full-text quota. kg_graph.py would ' +
      'fill the gap in arbitrary order. Re-run the heuristic stage with a larger k.');
    process.exit(1);
  }

  console.log(`\nDECLARED KG_FULL_TEXT_FRACTION=${fraction}.`);
  console.log('This script cannot read the server\'s environment. If the backend was not started');
  console.log(`with KG_FULL_TEXT_FRACTION=${fraction}, this arm will be mislabelled.`);
  console.log('\nbuilding graph — this is the long stage (an LLM call per packed batch)...');

  const t0 = Date.now();
  const out = await longPost(`/collections/${id}/pipeline/build-graph`, {});
  console.log(`finished in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(JSON.stringify(out).slice(0, 400));

  const row = await prisma.collection.findUnique({
    where: { id }, select: { knowledgeGraph: true },
  });
  const g = row?.knowledgeGraph;
  console.log(`graph present: ${g ? 'yes' : 'NO'}` +
    (g ? `  entities=${g.entities?.length ?? '?'}  relations=${g.relations?.length ?? '?'}` : ''));
  await prisma.$disconnect();
  process.exit(0);
}

console.error('usage: build_arms.mjs clone --from <id> --fraction <f>');
console.error('       build_arms.mjs graph --collection <id> --fraction <f>');
process.exit(1);
