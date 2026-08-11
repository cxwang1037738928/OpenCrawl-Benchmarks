/**
 * grade_v2.mjs — render the hand-graded unbiased benchmark into a report.
 *
 * Verdicts come from verdicts.v2.json, written by reading all 660 answers against
 * their expected answers. Every id carries an explicit verdict in every arm; PARTIAL
 * and WRONG also carry a one-line reason. An ungraded answer is a hard failure here,
 * not a warning — absent-means-correct is the one bug this report must not have.
 *
 * The v2 questions have no `type`. The meaningful split is the STRATUM: whether chunk
 * retrieval and the graph reach the support document at all. That is measured, not
 * chosen, and it is recorded per question in evidence.v2.json.
 *
 * The report also computes the noise floor for free. 73 of the 220 questions have
 * byte-identical fact windows in the floor-2 and floor-1 arms — same prompt, two draws
 * at temperature 0.2 with no seed. Verdict disagreements there are pure run-to-run
 * variance, and they are the yardstick every delta between arms has to clear.
 *
 * Run:  node experiments/04-unbiased/grade_v2.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'grading.v2.txt');
const W = 100;

const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf-8'));
const VERDICTS = read('verdicts.v2.json');
const QUESTIONS = read('questions.v2.json');
const EVIDENCE = read('evidence.v2.json');
const ARMS = VERDICTS.arms;

const records = {};
for (const arm of ARMS) {
  const byId = new Map();
  for (const line of fs.readFileSync(path.join(HERE, arm.file), 'utf-8').trim().split('\n')) {
    const r = JSON.parse(line);
    byId.set(r.id, r);
  }
  records[arm.key] = byId;
}

const ids = QUESTIONS.map((q) => q.id);
const stratumOf = (id) => {
  const s = EVIDENCE[id].strata;
  return `${s.chunkReachDoc ? 'chunk+' : 'chunk-'} ${s.graphReachDoc ? 'graph+' : 'graph-'}`;
};

// Hard-fail on an ungraded answer rather than silently scoring it correct.
for (const arm of ARMS) {
  const ungraded = ids.filter((id) => !VERDICTS.verdicts[arm.key]?.[id]);
  if (ungraded.length) {
    console.error(`FATAL: arm ${arm.key} has ${ungraded.length} ungraded answers `
      + `(${ungraded.slice(0, 8).join(', ')}). Refusing to report a score.`);
    process.exit(1);
  }
}

const vOf = (key, id) => VERDICTS.verdicts[key][id].v;
const whyOf = (key, id) => VERDICTS.verdicts[key][id].why ?? '';
const CODE = { CORRECT: 'C', PARTIAL: 'P', WRONG: 'F' };

const wrap = (text, indent = '') => {
  const out = [];
  let line = '';
  for (const word of String(text ?? '').replace(/\s+/g, ' ').split(' ')) {
    if (line && (line + ' ' + word).length > W - indent.length) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.map((l, i) => (i ? indent : '') + l).join('\n');
};

const tally = (key, subset) => {
  const c = { CORRECT: 0, PARTIAL: 0, WRONG: 0 };
  for (const id of subset) c[vOf(key, id)]++;
  return c;
};
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

const L = [];
const rule = (ch = '=') => L.push(ch.repeat(W));

rule();
L.push('UNBIASED BENCHMARK (v2) — HAND-GRADED RESULTS');
rule();
L.push('');
L.push(wrap('220 questions built without the retrieval bias: generated from document text sampled '
  + 'uniformly across the corpus, never filtered on whether retrieval or the graph can answer them. '
  + 'Both reachabilities were MEASURED afterwards and recorded as strata. Every one of the 660 '
  + 'answers was read by hand against its expected answer.'));
L.push('');
L.push(`reasoning model : ${VERDICTS.model}   topK ${VERDICTS.topK}`);
L.push(`graded          : ${VERDICTS.gradedThrough}`);
L.push('');

rule('-');
L.push('1. HEADLINE');
rule('-');
L.push('');
L.push('  arm                          C     P     F    accuracy   not-wrong');
for (const arm of ARMS) {
  const c = tally(arm.key, ids);
  L.push(`  ${arm.label.padEnd(26)}${String(c.CORRECT).padStart(3)}   ${String(c.PARTIAL).padStart(3)}`
    + `   ${String(c.WRONG).padStart(3)}     ${pct(c.CORRECT, 220).padStart(6)}     `
    + `${pct(c.CORRECT + c.PARTIAL, 220).padStart(6)}`);
}
L.push('');

// ---- the noise floor, measured from the identical-fact-window questions ----
const f2 = records['26f2'], f1 = records['26f1'];
const sameWindow = ids.filter((id) =>
  JSON.stringify(f2.get(id).graphFacts) === JSON.stringify(f1.get(id).graphFacts));
const diffWindow = ids.filter((id) => !sameWindow.includes(id));
const sameDisagree = sameWindow.filter((id) => vOf('26f2', id) !== vOf('26f1', id));

rule('-');
L.push('2. THE NOISE FLOOR (measured, not assumed)');
rule('-');
L.push('');
L.push(wrap(`${sameWindow.length} of the 220 questions got a byte-identical fact window in the floor-2 `
  + `and floor-1 arms. Same collection, same retrieval, same prompt — two draws at temperature 0.2 `
  + `with no seed. Any verdict disagreement between those two arms on those questions is pure `
  + `run-to-run variance and nothing else.`));
L.push('');
L.push(`  identical fact windows      : ${sameWindow.length}`);
L.push(`  verdict disagreements there : ${sameDisagree.length}  (${sameDisagree.join(', ') || 'none'})`);
L.push(`  implied noise floor         : ${pct(sameDisagree.length, sameWindow.length)} `
  + `= about ${Math.round((sameDisagree.length / sameWindow.length) * 220)} answers in 220`);
L.push('');
const spread = Math.max(...ARMS.map((a) => tally(a.key, ids).CORRECT))
  - Math.min(...ARMS.map((a) => tally(a.key, ids).CORRECT));
L.push(wrap(`Observed spread between the best and worst arm: ${spread} correct answers. Compare that `
  + `with the floor above before reading anything into it.`));
L.push('');

rule('-');
L.push('3. BY STRATUM — the split that actually predicts the answer');
rule('-');
L.push('');
L.push(wrap('chunk+/chunk- is whether ordinary chunk retrieval reached the support document; '
  + 'graph+/graph- is whether the graph did. Neither was used to select questions.'));
L.push('');
L.push('  stratum           n     ' + ARMS.map((a) => a.key.padEnd(16)).join(''));
for (const s of ['chunk+ graph+', 'chunk+ graph-', 'chunk- graph+', 'chunk- graph-']) {
  const subset = ids.filter((id) => stratumOf(id) === s);
  const cells = ARMS.map((a) => {
    const c = tally(a.key, subset);
    return `${c.CORRECT}/${c.PARTIAL}/${c.WRONG} ${pct(c.CORRECT, subset.length)}`.padEnd(16);
  });
  L.push(`  ${s.padEnd(16)}${String(subset.length).padStart(3)}   ${cells.join('')}`);
}
L.push('');
const chunkPlus = ids.filter((id) => stratumOf(id).startsWith('chunk+'));
const chunkMinus = ids.filter((id) => stratumOf(id).startsWith('chunk-'));
L.push(`  chunk+ overall (${chunkPlus.length})  `
  + ARMS.map((a) => `${a.key} ${pct(tally(a.key, chunkPlus).CORRECT, chunkPlus.length)}`).join('   '));
L.push(`  chunk- overall (${chunkMinus.length})  `
  + ARMS.map((a) => `${a.key} ${pct(tally(a.key, chunkMinus).CORRECT, chunkMinus.length)}`).join('   '));
L.push('');

rule('-');
L.push('4. DID CITING [G] HELP?');
rule('-');
L.push('');
L.push(wrap('Split each graph arm by whether its own answer actually cited a graph fact, and score '
  + 'the CONTROL on those same questions. The control never saw the graph, so any gap that survives '
  + 'in the control column is a property of the questions, not of the graph.'));
L.push('');
L.push('  arm    cited [G]?     n     that arm    control on the same ids');
for (const key of ['26f2', '26f1']) {
  for (const cited of [true, false]) {
    const subset = ids.filter((id) => Boolean(records[key].get(id).citedGraph) === cited);
    L.push(`  ${key.padEnd(7)}${(cited ? 'yes' : 'no').padEnd(15)}${String(subset.length).padStart(3)}`
      + `     ${pct(tally(key, subset).CORRECT, subset.length).padStart(6)}      `
      + `${pct(tally('33', subset).CORRECT, subset.length).padStart(6)}`);
  }
}
L.push('');

rule('-');
L.push('5. THE SEED FLOOR CHANGED THE FACT WINDOW AND NOT THE SCORE');
rule('-');
L.push('');
L.push(`  fact windows rewritten by floor 2 -> floor 1 : ${diffWindow.length} of 220`);
L.push(`  correct on those questions, floor 2          : ${tally('26f2', diffWindow).CORRECT}`);
L.push(`  correct on those questions, floor 1          : ${tally('26f1', diffWindow).CORRECT}`);
L.push('');

rule('-');
L.push('6. EVERY QUESTION WHERE THE ARMS DISAGREED');
rule('-');
L.push('');
const flips = ids.filter((id) => new Set(ARMS.map((a) => vOf(a.key, id))).size > 1);
L.push(`  ${flips.length} of 220 questions. Each one is a single answer; none is a pattern on its own.`);
L.push('');
for (const id of flips) {
  L.push(`  ${id}  [${stratumOf(id)}]   `
    + ARMS.map((a) => `${a.key}=${CODE[vOf(a.key, id)]}`).join('  '));
  L.push(wrap(`Q: ${QUESTIONS.find((q) => q.id === id).question}`, '      ').replace(/^/, '      '));
  for (const arm of ARMS) {
    const why = whyOf(arm.key, id);
    if (why) L.push(wrap(`${arm.key}: ${why}`, '            ').replace(/^/, '        '));
  }
  L.push('');
}

rule('-');
L.push('7. QUESTION DEFECTS');
rule('-');
L.push('');
L.push(wrap('Found while grading. Each is graded in the model\'s favour in ALL THREE arms, so no arm '
  + 'gains or loses from them.'));
L.push('');
for (const [id, note] of Object.entries(VERDICTS.questionFlaws)) {
  L.push(`  ${id}`);
  L.push(wrap(note, '      ').replace(/^/, '      '));
  L.push('');
}

rule('-');
L.push('8. FULL MATRIX');
rule('-');
L.push('');
L.push(`  id     stratum          ${ARMS.map((a) => a.key.padEnd(7)).join('')} flip`);
for (const id of ids) {
  const vs = ARMS.map((a) => CODE[vOf(a.key, id)]);
  L.push(`  ${id}   ${stratumOf(id).padEnd(16)}${vs.map((v) => v.padEnd(7)).join('')}`
    + `${new Set(vs).size > 1 ? ' <--' : ''}`);
}
L.push('');

rule('-');
L.push('9. WHAT THIS DOES AND DOES NOT SHOW');
rule('-');
L.push('');
for (const line of [
  'Reads as measured. Every verdict is explicit and carries a reason where it is not CORRECT.',
  '',
  'The arms share retrieval entirely. They differ only in the graph fact block, so any difference',
  'between them is attributable to the graph — but only if it clears the noise floor in section 2.',
  '',
  'The reasoning model runs at temperature 0.2 with no seed, so answers are not reproducible.',
  'This is the reason section 2 exists and the reason a small delta is not a finding.',
  '',
  'One grader, not blind to which arm produced which answer. On borderline answers that is a real',
  'source of bias; it is mitigated by the arms being read side by side against one expected answer.',
]) L.push(line ? `  ${line}` : '');
L.push('');

fs.writeFileSync(OUT, L.join('\n') + '\n', 'utf-8');
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${L.length} lines)`);
for (const arm of ARMS) {
  const c = tally(arm.key, ids);
  console.log(`  ${arm.key.padEnd(6)} C=${c.CORRECT} P=${c.PARTIAL} F=${c.WRONG} `
    + `acc=${pct(c.CORRECT, 220)}`);
}
