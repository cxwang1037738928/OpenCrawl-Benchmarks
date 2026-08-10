/**
 * grade_synthesis.mjs — render the hand-graded synthesis benchmark into a report.
 *
 * Verdicts come from verdicts.synthesis.json, which is written by reading every answer
 * against its expected answer — no pattern matching. Anything not listed there is
 * CORRECT; PARTIAL and WRONG carry a one-line reason.
 *
 * The report answers three questions in order of interest:
 *   1. does the graph arm beat the control arm overall, and per question type;
 *   2. on the questions where the graph actually contributed a [G] claim, does it;
 *   3. where the two arms disagree, what did each say.
 *
 * The third split is the one the previous ablation could not produce: an aggregate that
 * mixes questions the graph never touched into the average will report a null result
 * whether or not the graph works.
 *
 * Run:  node "Synthesis benchmark/grade_synthesis.mjs"
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT  = path.join(HERE, 'synthesis_grading.txt');
const W = 100;

const VERDICTS = JSON.parse(fs.readFileSync(path.join(HERE, 'verdicts.synthesis.json'), 'utf-8'));
const ARMS = VERDICTS.arms;                       // [{collectionId, label, file}]

const load = (file) => fs.readFileSync(path.join(ROOT, file), 'utf-8')
  .trim().split('\n').map((line) => JSON.parse(line));

// A re-asked question appears twice in the jsonl; the later record supersedes.
const records = {};
for (const arm of ARMS) {
  const byId = new Map();
  for (const record of load(arm.file)) byId.set(String(record.id).replace(/ \(re-asked\)$/, ''), record);
  records[arm.collectionId] = byId;
}

const ids = [...records[ARMS[0].collectionId].keys()];
const verdictOf = (armId, id) => {
  const arm = VERDICTS.verdicts[String(armId)] ?? {};
  return arm.PARTIAL?.[id] ? 'PARTIAL' : arm.WRONG?.[id] ? 'WRONG' : 'CORRECT';
};
const noteOf = (armId, id) => {
  const arm = VERDICTS.verdicts[String(armId)] ?? {};
  return arm.PARTIAL?.[id] || arm.WRONG?.[id] || '';
};

const wrap = (text, indent) => {
  const out = [];
  let line = '';
  for (const word of String(text ?? '').replace(/\s+/g, ' ').split(' ')) {
    if (line && (line + ' ' + word).length > W - indent.length) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
};

const pct = (n, d) => `${(100 * n / (d || 1)).toFixed(1)}%`;

const tally = (armId, filter = () => true) => {
  const counts = { CORRECT: 0, PARTIAL: 0, WRONG: 0, n: 0 };
  for (const id of ids) {
    if (!filter(id)) continue;
    counts[verdictOf(armId, id)]++;
    counts.n++;
  }
  return counts;
};

const L = [];
L.push('='.repeat(W));
L.push('SYNTHESIS BENCHMARK — every answer read and judged individually, in batches of 11');
L.push('='.repeat(W));
L.push('Ground truth is the claim made by one of the two review articles; the evidence for every');
L.push('component of that claim was verified to exist in a chunk of a cited collection-26 document');
L.push('before the question was admitted (see build_questions.mjs).');
L.push('');
L.push('The two arms hold the SAME 192 documents, the same 16,272 chunks and the same embeddings.');
L.push('Retrieval was confirmed identical, chunk for chunk, so the knowledge graph is the only');
L.push('variable between them.');
L.push('');
for (const arm of ARMS) L.push(`  collection ${String(arm.collectionId).padEnd(4)} ${arm.label.padEnd(28)} ${arm.file}`);
L.push('');
L.push(`reasoning model : ${VERDICTS.model}`);
L.push(`retrieval       : top-k ${VERDICTS.topK}, doc boost inactive (no question names a document)`);
L.push('');
L.push('RUBRIC');
L.push('  CORRECT — conveys the expected claim. Equivalent wording counts; extra correct detail');
L.push('            does not penalise.');
L.push('  PARTIAL — right direction but incomplete: part of a multi-part answer missing, or the');
L.push('            fact surfaced without being committed to.');
L.push('  WRONG   — contradicts the expected claim, or fails to answer it.');
L.push('');

L.push('-'.repeat(W));
L.push('RESULT');
L.push('-'.repeat(W));
L.push('  collection                          CORRECT     PARTIAL       WRONG     accuracy');
for (const arm of ARMS) {
  const t = tally(arm.collectionId);
  L.push(`  ${String(arm.collectionId).padEnd(4)} ${arm.label.padEnd(28)}`
    + `${String(t.CORRECT).padStart(6)}${String(t.PARTIAL).padStart(12)}${String(t.WRONG).padStart(12)}`
    + `${pct(t.CORRECT, t.n).padStart(13)}`);
}
const spread = Math.max(...ARMS.map((a) => tally(a.collectionId).CORRECT))
             - Math.min(...ARMS.map((a) => tally(a.collectionId).CORRECT));
L.push('');
L.push(`  Spread across the arms: ${spread} answers of ${ids.length}`);
L.push('');

// Per question type.
L.push('-'.repeat(W));
L.push('CORRECT BY QUESTION TYPE');
L.push('-'.repeat(W));
const typeOf = (id) => records[ARMS[0].collectionId].get(id).type;
const TYPES = ['single_doc', 'cross_doc', 'multi_hop', 'enumerate'];
L.push(`  type          n    ${ARMS.map((a) => `c${a.collectionId}`.padStart(12)).join('')}     delta`);
for (const type of TYPES) {
  const filter = (id) => typeOf(id) === type;
  const cells = ARMS.map((a) => tally(a.collectionId, filter));
  const delta = cells[0].CORRECT - cells[cells.length - 1].CORRECT;
  L.push(`  ${type.padEnd(13)}${String(cells[0].n).padStart(3)}    `
    + cells.map((t) => `${t.CORRECT}/${t.n} ${pct(t.CORRECT, t.n)}`.padStart(12)).join('')
    + `${(delta > 0 ? `+${delta}` : String(delta)).padStart(10)}`);
}
L.push('');

// The split that matters: did the graph actually contribute to this answer?
L.push('-'.repeat(W));
L.push('SPLIT BY WHETHER THE GRAPH ACTUALLY CONTRIBUTED');
L.push('-'.repeat(W));
L.push('A question the graph never touched cannot show a graph effect. Averaging those in is what');
L.push('made the previous ablation report a null result, so they are separated here.');
L.push('');
const graphArm = ARMS[0].collectionId;
const cited = (id) => records[graphArm].get(id)?.citedGraph === true;
const supplied = (id) => (records[graphArm].get(id)?.graphFactCount ?? 0) > 0;

for (const [label, filter] of [
  ['graph facts supplied AND cited [G]', cited],
  ['graph facts supplied, not cited', (id) => supplied(id) && !cited(id)],
  ['no graph facts supplied', (id) => !supplied(id)],
]) {
  const n = ids.filter(filter).length;
  L.push(`  ${label}  (${n} questions)`);
  for (const arm of ARMS) {
    const t = tally(arm.collectionId, filter);
    L.push(`      c${String(arm.collectionId).padEnd(3)} ${arm.label.padEnd(28)}`
      + `${t.CORRECT}/${t.n}`.padStart(9) + `${pct(t.CORRECT, t.n).padStart(10)}`);
  }
  L.push('');
}

// Retrieval reach, so a synthesis failure is not confused with a retrieval failure.
L.push('-'.repeat(W));
L.push('RETRIEVAL REACH (identical in both arms by construction)');
L.push('-'.repeat(W));
const reach = ids.map((id) => records[graphArm].get(id));
const hit = reach.reduce((sum, r) => sum + (r.supportDocsRetrieved ?? 0), 0);
const need = reach.reduce((sum, r) => sum + (r.supportDocCount ?? 0), 0);
L.push(`  support documents reached : ${hit}/${need}  ${pct(hit, need)}`);
L.push(`  questions reaching all of their support documents : `
  + `${reach.filter((r) => r.supportDocsRetrieved === r.supportDocCount).length}/${ids.length}`);
L.push(`  questions reaching none   : ${reach.filter((r) => r.supportDocsRetrieved === 0).length}/${ids.length}`);
L.push('');

// Disagreements.
L.push('-'.repeat(W));
L.push('WHERE THE ARMS DISAGREE');
L.push('-'.repeat(W));
let diffs = 0;
for (const id of ids) {
  const verdicts = ARMS.map((a) => verdictOf(a.collectionId, id));
  if (new Set(verdicts).size === 1) continue;
  diffs++;
  const base = records[graphArm].get(id);
  L.push('');
  L.push(`${id}  ${base.type}${cited(id) ? '   [G] cited' : ''}`);
  L.push(`  QUESTION : ${wrap(base.question, ' '.repeat(13))}`);
  L.push(`  EXPECTED : ${wrap(base.expected, ' '.repeat(13))}`);
  for (const [idx, arm] of ARMS.entries()) {
    const record = records[arm.collectionId].get(id);
    L.push(`  c${arm.collectionId} ${verdicts[idx].padEnd(8)}: `
      + wrap(record.reply || `(error: ${record.error})`, ' '.repeat(15)));
    if (noteOf(arm.collectionId, id)) {
      L.push(`         why : ${wrap(noteOf(arm.collectionId, id), ' '.repeat(15))}`);
    }
  }
}
L.push('');
L.push(`${diffs} of ${ids.length} questions were graded differently between the arms; `
  + `${ids.length - diffs} received the same verdict.`);
L.push('');

// Full listing.
L.push('-'.repeat(W));
L.push('EVERY QUESTION');
L.push('-'.repeat(W));
for (const id of ids) {
  const base = records[graphArm].get(id);
  L.push('');
  L.push(`${id} ${base.type}   `
    + ARMS.map((a) => `c${a.collectionId} ${verdictOf(a.collectionId, id)}`).join('   |   ')
    + `   graph ${base.graphFactCount} facts${cited(id) ? ', [G] cited' : ''}`
    + `   support ${base.supportDocsRetrieved}/${base.supportDocCount}`);
  L.push(`  QUESTION : ${wrap(base.question, ' '.repeat(13))}`);
  L.push(`  EXPECTED : ${wrap(base.expected, ' '.repeat(13))}`);
  for (const arm of ARMS) {
    const record = records[arm.collectionId].get(id);
    L.push(`  c${arm.collectionId} : ${wrap(record.reply || `(error: ${record.error})`, ' '.repeat(9))}`);
    if (noteOf(arm.collectionId, id)) {
      L.push(`      why: ${wrap(noteOf(arm.collectionId, id), ' '.repeat(11))}`);
    }
  }
}
L.push('');

fs.writeFileSync(OUT, L.join('\n'), 'utf-8');
console.log(`wrote ${OUT}`);
for (const arm of ARMS) {
  const t = tally(arm.collectionId);
  console.log(`c${arm.collectionId} ${arm.label}: ${t.CORRECT}/${t.n} = ${pct(t.CORRECT, t.n)}`
    + `  (partial ${t.PARTIAL}, wrong ${t.WRONG})`);
}
console.log(`graded differently between the arms: ${diffs}`);
