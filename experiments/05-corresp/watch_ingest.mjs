/**
 * watch_ingest.mjs — follow a pipeline run that is still going on the server.
 *
 * The ingest client hit undici's 5-minute headersTimeout while POST /pipeline/run held the
 * connection open through docling. That killed the CLIENT, not the run: an Express handler keeps
 * executing after its socket drops, so the stages carry on and only the response has nowhere to
 * go. Re-posting /run would therefore start a second pass over the same collection while the
 * first is mid-flight, which is why this watches instead of retrying.
 *
 * Progress is read from the two places the run actually leaves marks: the database (chunks,
 * categories, embeddingsMeta) and the collection's scratch directory, where each stage drops the
 * export the next one consumes. heuristic_output.json is the last of them, so its appearance is
 * the run's completion signal.
 *
 * Emits one line per observed change, then exits. Exit 0 = complete, 1 = the worker vanished
 * with the run unfinished.
 *
 * Run:  node watch_ingest.mjs [collectionId]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');
const ID = Number(process.argv[2] ?? 34);
const SCRATCH = path.join(OPENCRAWL, 'data', 'collections', String(ID));

const require = createRequire(path.join(OPENCRAWL, 'package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(OPENCRAWL, '.env'), 'utf8'));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL ?? process.env.DATABASE_URL } },
});

/** Is a python worker still running? Its absence with the run unfinished means it died. */
function workerAlive() {
  try {
    const out = execSync('powershell -NoProfile -Command ' +
      '"(Get-Process python*,python3* -ErrorAction SilentlyContinue | Measure-Object).Count"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.trim()) > 0;
  } catch { return true; }        // never kill the watch over a failed probe
}

const sizeOf = (f) => { try { return fs.statSync(path.join(SCRATCH, f)).size; } catch { return -1; } };
const STAGE_FILES = ['documents.json', 'doclings.json', 'categories.json',
  'embeddings.json', 'heuristic_output.json'];

let last = '';
let idleRounds = 0;

for (;;) {
  const chunks = await prisma.chunk.count({ where: { document: { collectionId: ID } } });
  const col = await prisma.collection.findUnique({
    where: { id: ID }, select: { categories: true, embeddingsMeta: true },
  });
  const files = STAGE_FILES.map((f) => `${f.replace('.json', '')}=${sizeOf(f)}`).join(' ');
  const state = `chunks=${chunks} cats=${col?.categories ? 'y' : 'n'} ` +
    `emb=${col?.embeddingsMeta ? 'y' : 'n'} ${files}`;

  if (state !== last) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${state}`);
    last = state;
    idleRounds = 0;
  } else {
    idleRounds += 1;
  }

  if (sizeOf('heuristic_output.json') > 2) {
    console.log('RUN COMPLETE — heuristic_output.json written');
    await prisma.$disconnect();
    process.exit(0);
  }

  // Nothing changed for ~10 minutes AND no python worker: the run is not going to finish.
  if (idleRounds >= 10 && !workerAlive()) {
    console.log('WORKER GONE and no progress — run did not complete');
    await prisma.$disconnect();
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 60_000));
}
