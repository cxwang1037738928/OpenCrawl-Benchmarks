/**
 * map_evidence.mjs — rewrite evidence.json from corpus filenames to collection document IDs.
 *
 * review.mjs writes supportDocIds as the names this experiment uses for its letters
 * ("BMRN_CORRESP_2024-09-16"). synthesis_benchmark.js compares supportDocIds against
 * `source.docId` from the retriever, which is the collection's own 16-hex document id. Left
 * unmapped, every comparison silently fails: supportDocsRetrieved is 0 for every question, the
 * per-stratum split -- the single most useful output of experiment 04 -- reads "retrieval never
 * reached the support document" for all 200 questions, and the number looks like a finding
 * rather than a join error.
 *
 * So this runs after ingest and before the benchmark, and it hard-fails on any letter it cannot
 * resolve rather than dropping it.
 *
 * Run:  node map_evidence.mjs --collection <id>
 *   --collection <id>  the ingested collection to read filenames from   (required)
 *   --dry-run          report the mapping, write nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const { values: flags } = parseArgs({
  options: {
    collection: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!flags.collection) {
  console.error('--collection <id> is required');
  process.exit(1);
}

// OpenCrawl is a Prisma app; its client and DATABASE_URL both come from the sibling repo so this
// one needs neither a schema copy nor its own .env.
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');
const require = createRequire(path.join(OPENCRAWL, 'package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(OPENCRAWL, '.env'), 'utf8'));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL ?? process.env.DATABASE_URL } },
});

// docId, NOT the row id. The retriever reports source.docId (retriever.js:103), which is the
// content hash, and clone_collection.js copies that field verbatim (clone_collection.js:127) --
// so a mapping built against the indexed collection stays valid for every clone of it. Mapping
// to the row id would produce ids that match nothing and a benchmark reporting zero support-doc
// retrieval on all 183 questions, which would read as a finding rather than a join error.
const docs = await prisma.document.findMany({
  where: { collectionId: Number(flags.collection) },
  select: { docId: true, filename: true },
});
if (!docs.length) {
  console.error(`collection ${flags.collection} has no documents`);
  process.exit(1);
}

// corpus files are named "<TICKER>_CORRESP_<date>.pdf"; the stem is the experiment's doc id.
const byStem = new Map(docs.map((d) => [path.parse(d.filename).name, d.docId]));

const EVIDENCE = path.join(HERE, 'evidence.json');
const evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));

const missing = new Set();
const mapped = Object.fromEntries(
  Object.entries(evidence).map(([qid, ev]) => {
    const ids = ev.supportDocIds.map((stem) => {
      const id = byStem.get(stem);
      if (!id) missing.add(stem);
      return id ?? stem;
    });
    return [qid, { ...ev, supportDocIds: ids, supportDocNames: ev.supportDocIds }];
  }),
);

console.log(`documents in collection ${flags.collection}: ${docs.length}`);
console.log(`questions in evidence.json          : ${Object.keys(evidence).length}`);
console.log(`distinct support letters referenced  : ` +
  `${new Set(Object.values(evidence).flatMap((e) => e.supportDocIds)).size}`);

if (missing.size) {
  console.error(`\nUNRESOLVED letters (${missing.size}) — these are not in the collection:`);
  for (const m of [...missing].sort().slice(0, 20)) console.error(`  ${m}`);
  console.error('\nrefusing to write a partially mapped evidence file');
  process.exit(1);
}

if (flags['dry-run']) {
  await prisma.$disconnect();
  const [qid, ev] = Object.entries(mapped)[0];
  console.log(`\ndry run — sample: ${qid} -> ${JSON.stringify(ev.supportDocIds)}`);
  process.exit(0);
}

fs.writeFileSync(path.join(HERE, 'evidence.mapped.json'), JSON.stringify(mapped, null, 1));
await prisma.$disconnect();
console.log('\nwrote evidence.mapped.json — pass this as EVIDENCE_FILE');
process.exit(0);
