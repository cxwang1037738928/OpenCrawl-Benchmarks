/**
 * reindex.mjs — re-chunk, re-embed, re-cluster and re-rank without re-extracting.
 *
 * Runs the three indexing stages that consume doclings.json, skipping extract entirely. docling
 * already produced the text; only the chunk prefixes were wrong, and those are rebuilt from the
 * Document.docling column that strip_titles.mjs edited. A full re-ingest would have re-run ~40
 * minutes of PDF parsing to arrive at exactly the same extracted text.
 *
 * Long calls go through node:http, not fetch: undici gives up on a response after five minutes
 * and the embed stage takes longer than that, which is how the original ingest run appeared to
 * die while the server carried on working.
 *
 * Run:  node reindex.mjs --collection 34 [--k 89]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');
const API = process.env.API_BASE ?? 'http://localhost:3000/api';

const { values: flags } = parseArgs({
  options: { collection: { type: 'string' }, k: { type: 'string', default: '89' } },
});
if (!flags.collection) { console.error('--collection <id> required'); process.exit(1); }
const ID = Number(flags.collection);

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

function post(pathname, payload) {
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
        let p; try { p = JSON.parse(text); } catch { p = text; }
        res.statusCode >= 400
          ? reject(new Error(`${pathname} -> ${res.statusCode} ${text.slice(0, 200)}`))
          : resolve(p);
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const before = await prisma.chunk.count({ where: { document: { collectionId: ID } } });
console.log(`chunks before: ${before}\n`);

const stages = [
  ['embed', { force: true }],
  ['categorize', { threshold: parseFloat(env.CATEGORIES_SIMILARITY || '0.65') }],
  ['heuristic', { k: Number(flags.k) }],
];
for (const [stage, params] of stages) {
  const t0 = Date.now();
  process.stdout.write(`${stage.padEnd(11)} ... `);
  try {
    const out = await post(`/collections/${ID}/pipeline/${stage}`, params);
    console.log(`ok  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${JSON.stringify(out).slice(0, 150)}`);
  } catch (err) {
    console.log(`FAILED  ${err.message}`);
    process.exit(1);
  }
}

const after = await prisma.chunk.count({ where: { document: { collectionId: ID } } });
const rows = await prisma.$queryRawUnsafe(
  'SELECT c.text FROM "Chunk" c JOIN "Document" d ON d.id=c."documentId" WHERE d."collectionId"=$1', ID);
const polluted = rows.filter((r) => /SEC correspondence/i.test(r.text)).length;
console.log(`\nchunks after : ${after}  (was ${before})`);
console.log(`chunks still containing "SEC correspondence": ${polluted}  ` +
  `(${(100 * polluted / rows.length).toFixed(0)}%, was 87%)`);
await prisma.$disconnect();
