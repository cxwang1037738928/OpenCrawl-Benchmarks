/**
 * consolidate.mjs — collapse every experiment down to what is worth keeping:
 * the question/answer pairs and the accuracy numbers.
 *
 * The raw run files are large (25 MB across four experiments), mostly duplicated
 * between runs/ and experiments/, and all of them are recoverable from git history.
 * What is not easily reconstructed is the pairing: question, expected answer, what
 * each arm actually replied, and how it was graded. That is what this writes out.
 *
 * Emits experiments/qa/<experiment>.json, one row per question:
 *   { id, question, expected, arms: { <arm>: { reply, verdict, why } } }
 *
 * 01-doc-boost and 02-kg-ablation predate the machine-readable verdict files; their
 * grades live only in the prose reports, so their rows carry replies without verdicts
 * and the reports are kept alongside.
 *
 * Run:  node experiments/consolidate.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'qa');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const readJsonl = (p) => fs.readFileSync(p, 'utf-8').trim().split('\n')
  .filter(Boolean).map((l) => JSON.parse(l));

fs.mkdirSync(OUT_DIR, { recursive: true });
const summary = [];

// ---------------------------------------------------------------- 01 + 02
// Shape: { study, questionIndex, content, expected, reply, targetFilename, ... }
// One file per arm; the arm is the collection the run was pointed at.
const legacy = [
  {
    exp: '01-doc-boost',
    arms: { '28': 'benchmark_2026-08-08T23-31-02Z.jsonl' },
  },
  {
    exp: '02-kg-ablation',
    arms: {
      '30': 'benchmark_2026-08-09T17-04-06Z.jsonl',
      '31': 'benchmark_2026-08-09T17-21-02Z.jsonl',
      '32': 'benchmark_2026-08-09T17-38-15Z.jsonl',
    },
  },
];

for (const { exp, arms } of legacy) {
  const rows = new Map();
  for (const [arm, file] of Object.entries(arms)) {
    const p = path.join(HERE, exp, file);
    if (!fs.existsSync(p)) { console.warn(`  skip missing ${exp}/${file}`); continue; }
    for (const r of readJsonl(p)) {
      const id = `${r.study}#${r.questionIndex}`;
      if (!rows.has(id)) {
        rows.set(id, {
          id,
          study: r.study,
          supportDoc: r.targetFilename ?? null,
          question: r.content,
          expected: r.expected,
          arms: {},
        });
      }
      rows.get(id).arms[arm] = { reply: r.reply ?? null, retrievedSupport: r.targetHits ?? null };
    }
  }
  const out = [...rows.values()];
  fs.writeFileSync(path.join(OUT_DIR, `${exp}.json`), JSON.stringify(out, null, 1) + '\n');
  summary.push(`${exp.padEnd(16)} ${String(out.length).padStart(4)} questions  `
    + `${Object.keys(arms).length} arm(s)  (verdicts in the prose report only)`);
}

// ---------------------------------------------------------------- 03 + 04
// Shape: { id, question, expected, reply, ... } plus a verdicts file keyed by arm.
const graded = [
  { exp: '03-synthesis', verdicts: 'verdicts.synthesis.json', questions: 'questions.json' },
  { exp: '04-unbiased', verdicts: 'verdicts.v2.json', questions: 'questions.v2.json' },
];

for (const { exp, verdicts, questions } of graded) {
  const V = readJson(path.join(HERE, exp, verdicts));
  const Q = readJson(path.join(HERE, exp, questions));
  const byArm = {};
  for (const arm of V.arms) {
    const p = path.join(HERE, exp, arm.file);
    if (!fs.existsSync(p)) { console.warn(`  skip missing ${exp}/${arm.file}`); continue; }
    // A re-asked question appears twice; the later record supersedes.
    const m = new Map();
    for (const r of readJsonl(p)) m.set(String(r.id).replace(/ \(re-asked\)$/, ''), r);
    byArm[arm.key] = m;
  }

  const out = Q.map((q) => {
    const arms = {};
    for (const arm of V.arms) {
      const rec = byArm[arm.key]?.get(q.id);
      const v = V.verdicts[arm.key]?.[q.id];
      arms[arm.key] = {
        label: arm.label,
        reply: rec?.reply ?? null,
        citedGraph: rec?.citedGraph ?? null,
        graphFactCount: rec?.graphFactCount ?? null,
        verdict: v?.v ?? null,
        why: v?.why ?? '',
      };
    }
    return { id: q.id, type: q.type ?? null, question: q.question, expected: q.expectedAnswer, arms };
  });

  fs.writeFileSync(path.join(OUT_DIR, `${exp}.json`), JSON.stringify(out, null, 1) + '\n');
  const tallies = V.arms.map((a) => {
    const c = { CORRECT: 0, PARTIAL: 0, WRONG: 0 };
    for (const row of out) { const v = row.arms[a.key].verdict; if (v) c[v]++; }
    return `${a.key} ${c.CORRECT}/${c.PARTIAL}/${c.WRONG}`;
  });
  summary.push(`${exp.padEnd(16)} ${String(out.length).padStart(4)} questions  `
    + `${V.arms.length} arms  ${tallies.join('  ')}`);
}

console.log('wrote experiments/qa/');
for (const line of summary) console.log('  ' + line);
const bytes = fs.readdirSync(OUT_DIR)
  .reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(`  total ${(bytes / 1024 / 1024).toFixed(1)} MB`);
