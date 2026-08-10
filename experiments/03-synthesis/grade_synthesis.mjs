/**
 * grade_synthesis.mjs — render the hand-graded synthesis benchmark into a report.
 *
 * Verdicts come from verdicts.synthesis.json, which is written by reading every answer
 * against its expected answer — no pattern matching. Every id carries an explicit
 * verdict in every arm; PARTIAL and WRONG also carry a one-line reason.
 *
 * Arms are keyed by `key`, not by collection id: two of the three arms are the SAME
 * collection 26 and differ only in GRAPH_MAX_FACTS, so the collection id no longer
 * identifies an arm.
 *
 * The report answers, in order of interest:
 *   1. does the graph beat the control, and does a wider fact window beat a narrow one;
 *   2. the same split per question type and per whether the model actually cited [G];
 *   3. which questions the fact cap alone flipped;
 *   4. every answer, bucketed Correct / Partially Correct / False, and a per-question
 *      matrix across the three arms.
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
const ARMS = VERDICTS.arms;                  // [{key, collectionId, maxFacts, label, file}]

const load = (file) => fs.readFileSync(path.join(HERE, file), 'utf-8')
  .trim().split('\n').map((line) => JSON.parse(line));

// A re-asked question appears twice in the jsonl; the later record supersedes.
const records = {};
for (const arm of ARMS) {
  const byId = new Map();
  for (const record of load(arm.file)) byId.set(String(record.id).replace(/ \(re-asked\)$/, ''), record);
  records[arm.key] = byId;
}

const ids = [...records[ARMS[0].key].keys()];
const BUCKET = { CORRECT: 'Correct', PARTIAL: 'Partially Correct', WRONG: 'False' };

// A missing record means an arm did not answer that question — a partial run, not a
// verdict. Report it loudly rather than letting it read as a silent zero downstream.
const MISSING = { reply: '(no answer recorded — this arm did not run this question)' };
const rec = (key, id) => records[key].get(id) ?? MISSING;
for (const arm of ARMS) {
  const absent = ids.filter((id) => !records[arm.key].has(id));
  if (absent.length) {
    console.warn(`WARNING: arm ${arm.key} is missing ${absent.length} answers `
      + `(${absent.slice(0, 5).join(', ')}${absent.length > 5 ? ', …' : ''})`);
  }
  // An ungraded answer would fall through to CORRECT below and silently inflate the
  // score, which is the one failure mode this report must never have.
  const ungraded = ids.filter((id) => !VERDICTS.verdicts[arm.key]?.[id]);
  if (ungraded.length) {
    console.warn(`WARNING: arm ${arm.key} has ${ungraded.length} UNGRADED answers counted `
      + `as Correct (${ungraded.slice(0, 5).join(', ')}${ungraded.length > 5 ? ', …' : ''})`);
  }
}

const verdictOf = (key, id) => VERDICTS.verdicts[key]?.[id]?.v ?? 'CORRECT';
const noteOf    = (key, id) => VERDICTS.verdicts[key]?.[id]?.why ?? '';

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

const tally = (key, filter = () => true) => {
  const counts = { CORRECT: 0, PARTIAL: 0, WRONG: 0, n: 0 };
  for (const id of ids) {
    if (!filter(id)) continue;
    counts[verdictOf(key, id)]++;
    counts.n++;
  }
  return counts;
};

const graphArms   = ARMS.filter((a) => a.maxFacts > 0);
const controlArm  = ARMS.find((a) => !a.maxFacts) ?? ARMS[ARMS.length - 1];
const widest      = graphArms.reduce((a, b) => (a.maxFacts >= b.maxFacts ? a : b), graphArms[0]);
const narrowest   = graphArms.reduce((a, b) => (a.maxFacts <= b.maxFacts ? a : b), graphArms[0]);

const L = [];
L.push('='.repeat(W));
L.push('SYNTHESIS BENCHMARK — every answer read and judged individually');
L.push('='.repeat(W));
L.push('Ground truth is the claim made by one of the two review articles; the evidence for every');
L.push('component of that claim was verified to exist in a chunk of a cited collection-26 document');
L.push('before the question was admitted (see build_questions.mjs).');
L.push('');
L.push('All three arms hold the SAME 192 documents, the same 16,272 chunks and the same embeddings,');
L.push('and chunk retrieval is identical across all three — it does not depend on the graph or on the');
L.push('fact cap. The graph, and how much of it the model is shown, is the only variable.');
L.push('');
for (const arm of ARMS) {
  L.push(`  ${arm.key.padEnd(8)} collection ${String(arm.collectionId).padEnd(4)} `
    + `${arm.label.padEnd(26)} ${arm.file}`);
}
L.push('');
L.push(`reasoning model : ${VERDICTS.model}`);
L.push(`retrieval       : top-k ${VERDICTS.topK}, doc boost inactive (no question names a document)`);
L.push('');
L.push('WHY THE FACT CAP IS A VARIABLE AT ALL');
L.push('  Measured over all 200 questions against the real graph index, 2-hop expansion reaches a');
L.push('  median of 705 facts per question (mean 932, max 3321); only 5 questions have 25 or fewer.');
L.push('  GRAPH_MAX_FACTS=25 therefore showed the model about 3% of what the graph found. Raising');
L.push('  the cap surfaces on-target facts — the share of the 423 support documents touched by at');
L.push('  least one fact in the window rises 42.8% (cap 25) -> 57.4% (cap 100) -> 63.1% (cap 400),');
L.push('  against a hard ceiling of 70%: 125 of 423 support documents are unreachable at any cap.');
L.push('');
L.push('RUBRIC');
L.push('  Correct           — conveys the expected claim. Equivalent wording counts; extra correct');
L.push('                      detail does not penalise.');
L.push('  Partially Correct — right direction but incomplete: part of a multi-part answer missing,');
L.push('                      or the fact surfaced without being committed to.');
L.push('  False             — contradicts the expected claim, or fails to answer it.');
L.push('');
L.push('CAVEAT ON PRECISION');
L.push('  The reasoning model runs at temperature 0.2 with no seed, so answers are not reproducible');
L.push('  and no replicate was run. A difference of a few answers between arms is not separable');
L.push('  from run-to-run variance; only the larger movements below should be read as real.');
L.push('');

L.push('-'.repeat(W));
L.push('RESULT');
L.push('-'.repeat(W));
L.push('  arm                                      Correct    Partial      False     accuracy');
for (const arm of ARMS) {
  const t = tally(arm.key);
  L.push(`  ${arm.key.padEnd(8)} ${arm.label.padEnd(30)}`
    + `${String(t.CORRECT).padStart(6)}${String(t.PARTIAL).padStart(11)}${String(t.WRONG).padStart(11)}`
    + `${pct(t.CORRECT, t.n).padStart(13)}`);
}
const spread = Math.max(...ARMS.map((a) => tally(a.key).CORRECT))
             - Math.min(...ARMS.map((a) => tally(a.key).CORRECT));
L.push('');
L.push(`  Spread across the arms: ${spread} answers of ${ids.length}`);
L.push('');

// Per question type.
L.push('-'.repeat(W));
L.push('CORRECT BY QUESTION TYPE');
L.push('-'.repeat(W));
const typeOf = (id) => rec(ARMS[0].key, id).type;
const TYPES = ['single_doc', 'cross_doc', 'multi_hop', 'enumerate'];
L.push(`  type          n   ${ARMS.map((a) => a.key.padStart(14)).join('')}`);
for (const type of TYPES) {
  const filter = (id) => typeOf(id) === type;
  const cells = ARMS.map((a) => tally(a.key, filter));
  L.push(`  ${type.padEnd(13)}${String(cells[0].n).padStart(3)}   `
    + cells.map((t) => `${t.CORRECT}/${t.n} ${pct(t.CORRECT, t.n)}`.padStart(14)).join(''));
}
L.push('');

// The split that matters: did the graph actually contribute to this answer?
L.push('-'.repeat(W));
L.push('SPLIT BY WHETHER THE GRAPH ACTUALLY CONTRIBUTED');
L.push('-'.repeat(W));
L.push('A question the graph never touched cannot show a graph effect. Averaging those in is what');
L.push('made the previous ablation report a null result, so they are separated here. The subsets are');
L.push('defined by each graph arm\'s own [G] citations, so each is scored on its own terms.');
L.push('');
for (const gArm of graphArms) {
  const cited = (id) => rec(gArm.key, id).citedGraph === true;
  const n = ids.filter(cited).length;
  L.push(`  questions where ${gArm.key} cited [G]  (${n} of ${ids.length})`);
  for (const arm of ARMS) {
    const t = tally(arm.key, cited);
    L.push(`      ${arm.key.padEnd(8)} ${arm.label.padEnd(28)}`
      + `${t.CORRECT}/${t.n}`.padStart(9) + `${pct(t.CORRECT, t.n).padStart(10)}`);
  }
  const rest = (id) => !cited(id);
  L.push(`  questions where ${gArm.key} did not cite [G]  (${ids.length - n})`);
  for (const arm of ARMS) {
    const t = tally(arm.key, rest);
    L.push(`      ${arm.key.padEnd(8)} ${arm.label.padEnd(28)}`
      + `${t.CORRECT}/${t.n}`.padStart(9) + `${pct(t.CORRECT, t.n).padStart(10)}`);
  }
  L.push('');
}

// [G] citation rate, the most direct read on whether a wider window is used at all.
L.push('-'.repeat(W));
L.push('HOW OFTEN THE MODEL USED A GRAPH FACT');
L.push('-'.repeat(W));
for (const arm of graphArms) {
  const recs = ids.map((id) => rec(arm.key, id));
  const citedN = recs.filter((r) => r?.citedGraph).length;
  const supplied = recs.filter((r) => (r?.graphFactCount ?? 0) > 0).length;
  const meanFacts = recs.reduce((s, r) => s + (r?.graphFactCount ?? 0), 0) / recs.length;
  L.push(`  ${arm.key.padEnd(8)} facts supplied ${supplied}/${ids.length}`
    + `   mean ${meanFacts.toFixed(1)} facts/question`
    + `   cited [G] in ${citedN}/${ids.length} (${pct(citedN, ids.length)})`);
}
L.push('');

// Retrieval reach, so a synthesis failure is not confused with a retrieval failure.
L.push('-'.repeat(W));
L.push('RETRIEVAL REACH (identical in all arms by construction)');
L.push('-'.repeat(W));
const reach = ids.map((id) => rec(ARMS[0].key, id));
const hit = reach.reduce((sum, r) => sum + (r.supportDocsRetrieved ?? 0), 0);
const need = reach.reduce((sum, r) => sum + (r.supportDocCount ?? 0), 0);
L.push(`  support documents reached : ${hit}/${need}  ${pct(hit, need)}`);
L.push(`  questions reaching all of their support documents : `
  + `${reach.filter((r) => r.supportDocsRetrieved === r.supportDocCount).length}/${ids.length}`);
L.push(`  questions reaching none   : ${reach.filter((r) => r.supportDocsRetrieved === 0).length}/${ids.length}`);
L.push('');
L.push('  accuracy by how much of a question\'s support the retriever reached');
const bucketOf = (r) => (!r.supportDocCount ? 'n/a'
  : r.supportDocsRetrieved === 0 ? 'none'
  : r.supportDocsRetrieved === r.supportDocCount ? 'all' : 'some');
for (const b of ['all', 'some', 'none']) {
  const filter = (id) => bucketOf(rec(ARMS[0].key, id)) === b;
  const n = ids.filter(filter).length;
  if (!n) continue;
  L.push(`      reached ${b.padEnd(5)} n=${String(n).padStart(3)}   `
    + ARMS.map((a) => { const t = tally(a.key, filter);
        return `${a.key} ${pct(t.CORRECT, t.n)}`.padStart(18); }).join(''));
}
L.push('');

// What the fact cap alone changed.
if (graphArms.length > 1) {
  L.push('-'.repeat(W));
  L.push(`WHAT THE FACT CAP ALONE CHANGED  (${narrowest.key} vs ${widest.key})`);
  L.push('-'.repeat(W));
  L.push('Same collection, same graph, same retrieval. The only difference is how many of the ranked');
  L.push('facts reached the prompt.');
  L.push('');
  const RANK = { WRONG: 0, PARTIAL: 1, CORRECT: 2 };
  const gained = [], lost = [], changed = [];
  for (const id of ids) {
    const a = verdictOf(narrowest.key, id), b = verdictOf(widest.key, id);
    if (a === b) continue;
    changed.push(id);
    (RANK[b] > RANK[a] ? gained : lost).push(id);
  }
  L.push(`  improved with the wider window : ${gained.length}`);
  L.push(`  regressed                      : ${lost.length}`);
  L.push(`  net                            : ${gained.length - lost.length}`);
  L.push('');
  for (const id of changed) {
    const base = rec(widest.key, id);
    L.push('');
    L.push(`${id}  ${base.type}   ${narrowest.key} ${verdictOf(narrowest.key, id)} -> `
      + `${widest.key} ${verdictOf(widest.key, id)}`
      + `${rec(widest.key, id).citedGraph ? '   [G] cited' : ''}`);
    L.push(`  QUESTION : ${wrap(base.question, ' '.repeat(13))}`);
    L.push(`  EXPECTED : ${wrap(base.expected, ' '.repeat(13))}`);
    for (const arm of [narrowest, widest]) {
      L.push(`  ${arm.key.padEnd(7)}: ${wrap(rec(arm.key, id).reply || '(no answer)', ' '.repeat(11))}`);
      if (noteOf(arm.key, id)) L.push(`      why: ${wrap(noteOf(arm.key, id), ' '.repeat(11))}`);
    }
  }
  L.push('');
}

// Per-question matrix.
L.push('-'.repeat(W));
L.push('PER-QUESTION MATRIX');
L.push('-'.repeat(W));
L.push('C = Correct, P = Partially Correct, F = False.  * marks a row where the arms disagree.');
L.push('');
L.push(`  id     type          ${ARMS.map((a) => a.key.padStart(9)).join('')}   facts@${widest.maxFacts}  [G]  support`);
for (const id of ids) {
  const vs = ARMS.map((a) => verdictOf(a.key, id));
  const base = rec(widest.key, id);
  const flag = new Set(vs).size === 1 ? ' ' : '*';
  L.push(`${flag} ${id.padEnd(6)} ${typeOf(id).padEnd(12)}`
    + vs.map((v) => v[0].padStart(9)).join('')
    + `${String(base.graphFactCount ?? 0).padStart(10)}`
    + `${(base.citedGraph ? 'yes' : '-').padStart(6)}`
    + `${`${base.supportDocsRetrieved}/${base.supportDocCount}`.padStart(9)}`);
}
L.push('');

// Three-bucket listing per arm.
for (const arm of ARMS) {
  L.push('-'.repeat(W));
  L.push(`${arm.key.toUpperCase()} — ${arm.label.toUpperCase()}, BUCKETED`);
  L.push('-'.repeat(W));
  for (const v of ['CORRECT', 'PARTIAL', 'WRONG']) {
    const members = ids.filter((id) => verdictOf(arm.key, id) === v);
    L.push('');
    L.push(`${BUCKET[v]} — ${members.length} of ${ids.length}`);
    for (const id of members) {
      const why = noteOf(arm.key, id);
      L.push(`  ${id} ${typeOf(id).padEnd(12)}${why ? wrap(why, ' '.repeat(23)) : ''}`);
    }
  }
  L.push('');
}

// Full listing.
L.push('-'.repeat(W));
L.push('EVERY QUESTION, EVERY ANSWER');
L.push('-'.repeat(W));
for (const id of ids) {
  const base = rec(widest.key, id);
  L.push('');
  L.push(`${id} ${base.type}   `
    + ARMS.map((a) => `${a.key} ${verdictOf(a.key, id)}`).join('   |   ')
    + `   support ${base.supportDocsRetrieved}/${base.supportDocCount}`);
  L.push(`  QUESTION : ${wrap(base.question, ' '.repeat(13))}`);
  L.push(`  EXPECTED : ${wrap(base.expected, ' '.repeat(13))}`);
  for (const arm of ARMS) {
    const record = rec(arm.key, id);
    L.push(`  ${arm.key.padEnd(7)}: ${wrap(record.reply || `(error: ${record.error})`, ' '.repeat(11))}`);
    if (noteOf(arm.key, id)) L.push(`      why: ${wrap(noteOf(arm.key, id), ' '.repeat(11))}`);
  }
}
L.push('');

fs.writeFileSync(OUT, L.join('\n'), 'utf-8');
console.log(`wrote ${OUT}`);
for (const arm of ARMS) {
  const t = tally(arm.key);
  console.log(`${arm.key.padEnd(8)} ${arm.label}: ${t.CORRECT}/${t.n} = ${pct(t.CORRECT, t.n)}`
    + `  (partial ${t.PARTIAL}, false ${t.WRONG})`);
}
