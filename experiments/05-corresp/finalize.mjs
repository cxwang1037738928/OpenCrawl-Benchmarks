/**
 * finalize.mjs — merge the reviewed pools into the benchmark's questions.json / evidence.json.
 *
 * Two pools exist because candidate ids are positional: the first 240 were generated, read and
 * judged, and regenerating that file to add more would have silently reassigned every id and
 * invalidated all 240 verdicts. The supplement was therefore generated into its own file with
 * its own verdicts, and both are merged here.
 *
 * Refuses to run if any candidate in either pool is unreviewed. A benchmark assembled from a
 * partially-read set is exactly the failure this whole review was meant to prevent.
 *
 * Run:  node finalize.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, 'raw');
const read = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));

const POOLS = [
  { name: 'primary', candidates: 'candidates.json', review: 'review.json' },
  { name: 'supplement', candidates: 'candidates.supp.json', review: 'review.supp.json' },
];

const kept = [];
for (const pool of POOLS) {
  const candidates = read(pool.candidates);
  const review = read(pool.review);
  const todo = candidates.filter((q) => !review[q.id]);
  if (todo.length) {
    console.error(`refusing to finalize: ${todo.length} unreviewed in ${pool.name} ` +
                  `(${todo.slice(0, 5).map((q) => q.id).join(', ')})`);
    process.exit(1);
  }
  for (const q of candidates) {
    if (review[q.id].v === 'keep') kept.push({ ...q, pool: pool.name, poolId: q.id });
  }
  console.log(`${pool.name.padEnd(11)} ${candidates.length} reviewed, ` +
              `${candidates.filter((q) => review[q.id].v === 'keep').length} kept`);
}

// Stable order: group by archetype so a truncated run (--limit) still covers every question
// shape rather than exhausting one archetype before reaching the next.
kept.sort((a, b) => (a.type === b.type
  ? a.poolId.localeCompare(b.poolId) || a.pool.localeCompare(b.pool)
  : a.type.localeCompare(b.type)));

const questions = [];
const evidence = {};
kept.forEach((q, i) => {
  const id = `C${String(i + 1).padStart(3, '0')}`;
  questions.push({ id, type: q.type, question: q.question, expectedAnswer: q.expectedAnswer });
  evidence[id] = {
    supportDocIds: q.supportDocIds,
    hub: q.hub,
    nDocs: q.nDocs,
    supportFilers: q.supportFilers,
    origin: `${q.pool}:${q.poolId}`,
  };
});

fs.writeFileSync(path.join(HERE, 'questions.json'), JSON.stringify(questions, null, 1));
fs.writeFileSync(path.join(HERE, 'evidence.json'), JSON.stringify(evidence, null, 1));

const byType = {};
for (const q of questions) byType[q.type] = (byType[q.type] ?? 0) + 1;
const docs = Object.values(evidence).map((e) => e.nDocs).sort((a, b) => a - b);
const letters = new Set(Object.values(evidence).flatMap((e) => e.supportDocIds));
const filers = new Set(Object.values(evidence).flatMap((e) => e.supportFilers));

console.log(`\nquestions.json : ${questions.length}`);
console.log(`by archetype   : ${JSON.stringify(byType)}`);
console.log(`support docs   : min ${docs[0]}  median ${docs[Math.floor(docs.length / 2)]}  ` +
            `max ${docs[docs.length - 1]}`);
console.log(`distinct letters referenced: ${letters.size}   filers: ${filers.size}`);
console.log(`single-hop questions (nDocs<2): ${docs.filter((d) => d < 2).length}`);
