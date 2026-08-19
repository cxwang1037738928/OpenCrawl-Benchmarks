/**
 * review.mjs — read every candidate question by hand before it becomes a benchmark.
 *
 * The composer guarantees a question spans >=2 documents, but that is a structural check and it
 * cannot see meaning. A keyword topic tag can fire on a false positive and put a company in an
 * answer set it does not belong in. A "compare" question can pick two filers who took the same
 * position, making the answer trivially "yes, both agreed to revise". A "timeline" question can
 * land on a filer whose two cycles share no subject, leaving a gold answer that says nothing.
 * None of those are visible to code. They are visible on reading.
 *
 * So every question is read individually and marked keep or reject against a fixed rubric:
 *
 *   R1  multi-hop      answering genuinely needs >=2 documents, not just cites 2
 *   R2  entity-linked  those documents are joined by an entity a graph could index
 *   R3  grounded       the gold answer follows from corpus text, not outside knowledge
 *   R4  no shortcut    no single chunk contains the whole answer
 *   R5  no giveaway    the question does not name the documents so exactly that BM25 wins free
 *   R6  gradable       the gold answer is specific enough for a judge to score against
 *
 * R1 and R4 are the ones that matter for this experiment's claim. A question that fails either
 * is a RAG question wearing an aggregation costume, and including it would quietly recreate the
 * conditions that made experiments 02-04 null.
 *
 * Usage:
 *   node review.mjs show [--type set] [--start 0] [--n 10]
 *   node review.mjs record '<json>'    // {"Q001":{"v":"keep"},"Q002":{"v":"reject","why":"..."}}
 *   node review.mjs status
 *   node review.mjs finalize           // writes questions.json + evidence.json from kept rows
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.join(HERE, 'raw');
// The supplement is reviewed as its own pool with its own verdict file: candidate ids are
// positional, so merging two generations into one file would silently invalidate verdicts
// already recorded against the first. finalize reads both.
const CANDIDATES = path.join(RAW, process.env.CANDIDATES ?? 'candidates.json');
const REVIEW = path.join(RAW, process.env.REVIEW ?? 'review.json');

const readJson = (p, dflt) =>
  fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : dflt;

const candidates = readJson(CANDIDATES, null);
if (!candidates) {
  console.error('raw/candidates.json missing — run compose_questions.py first');
  process.exit(1);
}
const review = readJson(REVIEW, {});

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'status';
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};

const wrap = (s, width = 96, indent = '    ') =>
  String(s ?? '')
    .split('\n')
    .flatMap((line) => {
      const out = [];
      let cur = '';
      for (const word of line.split(/\s+/)) {
        if (cur && (cur + ' ' + word).length > width) {
          out.push(cur);
          cur = word;
        } else cur = cur ? `${cur} ${word}` : word;
      }
      out.push(cur);
      return out;
    })
    .map((l) => indent + l)
    .join('\n');

if (cmd === 'show') {
  const type = flag('type', null);
  const start = Number(flag('start', 0));
  const n = Number(flag('n', 10));
  const pool = candidates.filter((q) => (type ? q.type === type : true));
  const batch = pool.slice(start, start + n);

  for (const q of batch) {
    const mark = review[q.id] ? `[${review[q.id].v}]` : '[ungraded]';
    console.log('='.repeat(100));
    console.log(`${q.id}  ${q.type.toUpperCase()}  hub="${q.hub}"  ` +
                `docs=${q.nDocs}  filers=${q.supportFilers.join(',')}  ${mark}`);
    console.log('-'.repeat(100));
    console.log('  QUESTION');
    console.log(wrap(q.question));
    console.log('  GOLD');
    console.log(wrap(q.expectedAnswer));
    console.log('  SUPPORT DOCS');
    console.log(wrap(q.supportDocIds.join('  ')));
    console.log();
  }
  console.log(`shown ${batch.length} of ${pool.length}` +
              (type ? ` (type=${type})` : '') + `  [start=${start}]`);
  process.exit(0);
}

if (cmd === 'record') {
  const payload = JSON.parse(argv[1]);
  const known = new Set(candidates.map((q) => q.id));
  const overwritten = [];
  let n = 0;
  for (const [id, val] of Object.entries(payload)) {
    if (!known.has(id)) {
      console.error(`unknown question id: ${id}`);
      process.exit(1);
    }
    if (!['keep', 'reject'].includes(val.v)) {
      console.error(`${id}: verdict must be keep or reject, got ${val.v}`);
      process.exit(1);
    }
    if (val.v === 'reject' && !val.why) {
      console.error(`${id}: a reject needs a reason`);
      process.exit(1);
    }
    if (review[id] && review[id].v !== val.v) overwritten.push(id);
    review[id] = val;
    n += 1;
  }
  fs.writeFileSync(REVIEW, JSON.stringify(review, null, 1));
  console.log(`recorded ${n}; total reviewed ${Object.keys(review).length}/${candidates.length}`);
  if (overwritten.length) console.log(`OVERWROTE prior verdicts: ${overwritten.join(', ')}`);
  process.exit(0);
}

if (cmd === 'status') {
  const byType = {};
  for (const q of candidates) {
    const t = (byType[q.type] ??= { total: 0, keep: 0, reject: 0, todo: 0 });
    t.total += 1;
    const v = review[q.id]?.v;
    if (v === 'keep') t.keep += 1;
    else if (v === 'reject') t.reject += 1;
    else t.todo += 1;
  }
  console.log('type          total   keep  reject   todo');
  let tot = { total: 0, keep: 0, reject: 0, todo: 0 };
  for (const k of Object.keys(byType).sort()) {
    const t = byType[k];
    for (const f of Object.keys(tot)) tot[f] += t[f];
    console.log(`${k.padEnd(12)} ${String(t.total).padStart(6)} ` +
                `${String(t.keep).padStart(6)} ${String(t.reject).padStart(7)} ` +
                `${String(t.todo).padStart(6)}`);
  }
  console.log('-'.repeat(44));
  console.log(`${'ALL'.padEnd(12)} ${String(tot.total).padStart(6)} ` +
              `${String(tot.keep).padStart(6)} ${String(tot.reject).padStart(7)} ` +
              `${String(tot.todo).padStart(6)}`);

  const reasons = {};
  for (const r of Object.values(review)) {
    if (r.v === 'reject') reasons[r.why] = (reasons[r.why] ?? 0) + 1;
  }
  if (Object.keys(reasons).length) {
    console.log('\nreject reasons:');
    for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${why}`);
    }
  }
  process.exit(0);
}

if (cmd === 'finalize') {
  const todo = candidates.filter((q) => !review[q.id]);
  if (todo.length) {
    console.error(`refusing to finalize: ${todo.length} questions unreviewed ` +
                  `(${todo.slice(0, 5).map((q) => q.id).join(', ')}...)`);
    process.exit(1);
  }
  const kept = candidates.filter((q) => review[q.id].v === 'keep');
  const questions = kept.map((q) => ({
    id: q.id,
    type: q.type,
    question: q.question,
    expectedAnswer: q.expectedAnswer,
  }));
  const evidence = Object.fromEntries(
    kept.map((q) => [q.id, { supportDocIds: q.supportDocIds, hub: q.hub, nDocs: q.nDocs }]),
  );
  fs.writeFileSync(path.join(HERE, 'questions.json'), JSON.stringify(questions, null, 1));
  fs.writeFileSync(path.join(HERE, 'evidence.json'), JSON.stringify(evidence, null, 1));
  console.log(`wrote questions.json (${questions.length}) and evidence.json`);
  process.exit(0);
}

console.error(`unknown command: ${cmd}`);
process.exit(1);
