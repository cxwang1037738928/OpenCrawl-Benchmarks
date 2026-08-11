/**
 * record_verdicts.mjs — merge a batch of hand verdicts into verdicts.synthesis.json.
 *
 * Grading 600 answers is too long to hold in one pass, so verdicts are written a batch
 * at a time and checkpointed here rather than by rewriting the whole file by hand.
 *
 * Input is JSON on stdin, keyed by arm then by question id:
 *   {"26@25":  {"Q001":"C", "Q005":["P","gave X without Y"]},
 *    "26@100": {"Q001":"C"},
 *    "33":     {"Q001":["F","denied the corpus contains X"]}}
 *
 * "C"/"P"/"F" expand to CORRECT/PARTIAL/WRONG. A bare string is a verdict with no
 * reason; a [verdict, reason] pair carries one. PARTIAL and WRONG without a reason are
 * rejected — an unexplained downgrade is not a judgement anyone can check.
 *
 * Serves any experiment directory via BENCH / VERDICTS_FILE, not just this one.
 *
 * Run:  node experiments/03-synthesis/record_verdicts.mjs --through Q050 < batch.json
 *       BENCH=04-unbiased VERDICTS_FILE=experiments/04-unbiased/verdicts.v2.json \
 *         node experiments/03-synthesis/record_verdicts.mjs --through "…" < batch.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PATH = process.env.VERDICTS_FILE
  ? path.resolve(process.env.VERDICTS_FILE)
  : path.join(path.resolve(ROOT, process.env.BENCH || '03-synthesis'), 'verdicts.synthesis.json');
const EXPAND = { C: 'CORRECT', P: 'PARTIAL', F: 'WRONG' };

const through = process.argv.includes('--through')
  ? process.argv[process.argv.indexOf('--through') + 1] : null;

const raw = fs.readFileSync(0, 'utf-8').trim();
if (!raw) { console.error('nothing on stdin'); process.exit(1); }
const batch = JSON.parse(raw);

const file = JSON.parse(fs.readFileSync(PATH, 'utf-8'));
const armKeys = new Set(file.arms.map((a) => a.key));

let written = 0;
const overwritten = [];        // regrading is allowed, but never silently
for (const [armKey, entries] of Object.entries(batch)) {
  if (!armKeys.has(armKey)) { console.error(`unknown arm "${armKey}"`); process.exit(1); }
  file.verdicts[armKey] ??= {};
  for (const [id, value] of Object.entries(entries)) {
    const [code, why] = Array.isArray(value) ? value : [value, ''];
    const v = EXPAND[code] ?? code;
    if (!['CORRECT', 'PARTIAL', 'WRONG'].includes(v)) {
      console.error(`${armKey} ${id}: bad verdict "${code}"`); process.exit(1);
    }
    if (v !== 'CORRECT' && !why) {
      console.error(`${armKey} ${id}: ${v} needs a reason`); process.exit(1);
    }
    const prior = file.verdicts[armKey][id];
    if (prior && prior.v !== v) overwritten.push(`${armKey} ${id} ${prior.v}->${v}`);
    else if (prior) overwritten.push(`${armKey} ${id} ${prior.v} (unchanged)`);
    file.verdicts[armKey][id] = why ? { v, why } : { v };
    written++;
  }
}
if (through) file.gradedThrough = through;

fs.writeFileSync(PATH, JSON.stringify(file, null, 2) + '\n', 'utf-8');
const counts = file.arms.map((a) => `${a.key} ${Object.keys(file.verdicts[a.key] ?? {}).length}`);
console.log(`merged ${written} verdicts; totals: ${counts.join(', ')}`
  + (through ? `; graded through ${through}` : ''));
if (overwritten.length) {
  console.log(`REGRADED ${overwritten.length}: ${overwritten.join('; ')}`);
}
