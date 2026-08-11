/**
 * show_batch.mjs — print a batch of questions with every arm's answer side by side.
 *
 * Grading reads each question and its expected answer ONCE and judges all three arms
 * against it, rather than making three passes over the same ground truth. The arms are
 * unlabelled by design where it matters least — the point is to judge the answer, not
 * the arm — but the ids are needed to record the verdict, so they are shown.
 *
 * Replies print in FULL. An earlier scratch helper truncated at 420 characters, which is
 * under the median reply length — answers whose substance follows a preamble would have
 * been graded on the preamble.
 *
 * Serves any experiment directory, not just this one, via BENCH:
 *
 *   node experiments/03-synthesis/show_batch.mjs 1 10
 *   BENCH=04-unbiased VERDICTS_FILE=… QUESTIONS_FILE=… EVIDENCE_FILE=… \
 *     node experiments/03-synthesis/show_batch.mjs --stratum "chunk- graph-" 1 10
 *
 * --stratum selects from the questions whose evidence carries that stratum, and <from>/<to>
 * then index into that filtered list — so a stratum can be graded straight through.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BENCH_DIR = path.resolve(ROOT, process.env.BENCH || '03-synthesis');
const at = (envKey, dflt) => (process.env[envKey]
  ? path.resolve(process.env[envKey]) : path.join(BENCH_DIR, dflt));
const W = 96;

const VERDICTS = JSON.parse(fs.readFileSync(at('VERDICTS_FILE', 'verdicts.synthesis.json'), 'utf-8'));
const questions = JSON.parse(fs.readFileSync(at('QUESTIONS_FILE', 'questions.json'), 'utf-8'));
const evidence  = JSON.parse(fs.readFileSync(at('EVIDENCE_FILE', 'evidence.json'), 'utf-8'));

const load = (file) => {
  const byId = new Map();
  for (const line of fs.readFileSync(path.join(BENCH_DIR, file), 'utf-8').trim().split('\n')) {
    const record = JSON.parse(line);
    byId.set(String(record.id).replace(/ \(re-asked\)$/, ''), record);   // later record wins
  }
  return byId;
};
const records = Object.fromEntries(VERDICTS.arms.map((arm) => [arm.key, load(arm.file)]));

// v1 questions carry a `type`; v2 questions do not, and the meaningful split there is the
// stratum — whether chunk retrieval and the graph reach the support document at all.
const stratumOf = (id) => {
  const s = evidence[id]?.strata;
  if (!s) return null;
  return `${s.chunkReachDoc ? 'chunk+' : 'chunk-'} ${s.graphReachDoc ? 'graph+' : 'graph-'}`;
};
const labelOf = (q) => q.type ?? stratumOf(q.id) ?? '?';

const argv = process.argv.slice(2);
const si = argv.indexOf('--stratum');
const wantStratum = si === -1 ? null : argv.splice(si, 2)[1];
const pool = wantStratum ? questions.filter((q) => stratumOf(q.id) === wantStratum) : questions;

const from = Number(argv[0] || 1);
const to   = Number(argv[1] || from + 9);

const wrap = (text, indent = '') => {
  const out = [];
  let line = '';
  for (const word of String(text ?? '').replace(/\s+/g, ' ').split(' ')) {
    if (line && (line + ' ' + word).length > W - indent.length) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.map((l) => indent + l).join('\n');
};

const batch = pool.slice(from - 1, to);
if (!batch.length) {
  console.error(`no questions at ${from}..${to}`
    + (wantStratum ? ` of stratum "${wantStratum}" (${pool.length} in it)` : ''));
  process.exit(1);
}
console.log(`# batch ${from}..${Math.min(to, pool.length)} of `
  + `${pool.length}${wantStratum ? ` in stratum "${wantStratum}"` : ''}`);

for (const q of batch) {
  const ev = evidence[q.id];
  const anyRec = records[VERDICTS.arms[0].key].get(q.id);
  console.log('\n' + '#'.repeat(W));
  console.log(`# ${q.id}  [${labelOf(q)}]   support ${anyRec?.supportDocsRetrieved ?? '?'}/${anyRec?.supportDocCount ?? ev.supportDocIds.length} docs retrieved`);
  console.log('#'.repeat(W));
  console.log(wrap(`Q: ${q.question}`));
  console.log('');
  console.log(wrap(`EXPECTED: ${q.expectedAnswer}`));

  for (const arm of VERDICTS.arms) {
    const r = records[arm.key].get(q.id);
    const tag = `${arm.key}${r?.citedGraph ? '  [G] cited' : ''}${r?.graphFactCount ? `  ${r.graphFactCount} facts` : ''}`;
    console.log('\n' + '-'.repeat(W));
    console.log(`--- ${tag}`);
    console.log('-'.repeat(W));
    console.log(wrap(r?.reply ?? '(no answer recorded)'));
  }
}
