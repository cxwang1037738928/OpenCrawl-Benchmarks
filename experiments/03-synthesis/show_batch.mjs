/**
 * show_batch.mjs — print a batch of questions with every arm's answer side by side.
 *
 * Grading reads each question and its expected answer ONCE and judges all three arms
 * against it, rather than making three passes over the same ground truth. The arms are
 * unlabelled by design where it matters least — the point is to judge the answer, not
 * the arm — but the ids are needed to record the verdict, so they are shown.
 *
 * Run:  node "Synthesis benchmark/show_batch.mjs" <from> <to>
 *       node "Synthesis benchmark/show_batch.mjs" 1 10
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const W = 96;

const VERDICTS = JSON.parse(fs.readFileSync(path.join(HERE, 'verdicts.synthesis.json'), 'utf-8'));
const questions = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf-8'));
const evidence  = JSON.parse(fs.readFileSync(path.join(HERE, 'evidence.json'), 'utf-8'));

const load = (file) => {
  const byId = new Map();
  for (const line of fs.readFileSync(path.join(HERE, file), 'utf-8').trim().split('\n')) {
    const record = JSON.parse(line);
    byId.set(String(record.id).replace(/ \(re-asked\)$/, ''), record);   // later record wins
  }
  return byId;
};
const records = Object.fromEntries(VERDICTS.arms.map((arm) => [arm.key, load(arm.file)]));

const from = Number(process.argv[2] || 1);
const to   = Number(process.argv[3] || from + 9);

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

for (const q of questions.slice(from - 1, to)) {
  const ev = evidence[q.id];
  const anyRec = records[VERDICTS.arms[0].key].get(q.id);
  console.log('\n' + '#'.repeat(W));
  console.log(`# ${q.id}  [${q.type}]   support ${anyRec?.supportDocsRetrieved ?? '?'}/${anyRec?.supportDocCount ?? ev.supportDocIds.length} docs retrieved`);
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
