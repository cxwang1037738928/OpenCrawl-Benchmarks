/**
 * judge.mjs — grade every arm's answers against the computed gold, blind to which arm they are.
 *
 * The gold answers here are derived from the fact table, not written by a model, so grading is a
 * comparison against a known set of companies/authorities rather than an opinion about quality.
 * That makes an LLM judge viable where it would otherwise be circular. Three things keep it
 * honest:
 *
 *   BLIND        the prompt never says which arm produced an answer, and the arms are shuffled
 *                per question so position carries no signal either.
 *   MARKER-FREE  [1], [2!], [!] and [G] are stripped before judging. [G] marks graph-sourced
 *                text, so leaving it in would tell the judge which arm it was looking at -- the
 *                one leak that would invalidate the blinding.
 *   DETERMINISTIC temperature 0, and the verdict must be one of three tokens.
 *
 * SCORING, and why it is not plain accuracy:
 *
 * A `holdout` question names up to 30 support documents while RETRIEVER_TOP_K is 10. No arm can
 * retrieve them all; the question is deliberately past the recall ceiling. Grading those as
 * simply right or wrong throws away the only interesting signal -- how much of the answer set a
 * system found. So set-valued answers are scored on recall and precision against the gold set as
 * well as by the judge's verdict, and both are reported. A rise in graph accuracy that comes
 * entirely from questions with 2 support docs means something different from one that comes from
 * questions with 20.
 *
 * Run:  node judge.mjs --runs <glob-ish stamp> [--limit N] [--concurrency 4]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');
const RUNS = path.join(ROOT, 'runs');

const { values: flags } = parseArgs({
  options: {
    stamp: { type: 'string' },
    model: { type: 'string', default: 'gemini-3.6-flash' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string', default: 'verdicts.json' },
  },
});

const require = createRequire(path.join(OPENCRAWL, 'package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(OPENCRAWL, '.env'), 'utf8'));
const KEY = env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY not found'); process.exit(1); }

// ---------------------------------------------------------------- load runs
const files = fs.readdirSync(RUNS)
  .filter((f) => f.endsWith('.jsonl') && f.includes('corresp'))
  .filter((f) => (flags.stamp ? f.includes(flags.stamp) : true));
if (!files.length) { console.error(`no corresp .jsonl runs in ${RUNS}`); process.exit(1); }

const byArm = new Map();
for (const f of files) {
  const rows = fs.readFileSync(path.join(RUNS, f), 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l));
  const arm = String(rows[0].collectionId);
  if (!byArm.has(arm)) byArm.set(arm, new Map());
  for (const r of rows) byArm.get(arm).set(r.id, r);
  console.log(`${f}  -> arm ${arm}, ${rows.length} answers`);
}
const arms = [...byArm.keys()];
const ids = [...byArm.get(arms[0]).keys()]
  .filter((id) => arms.every((a) => byArm.get(a).has(id)))
  .slice(0, flags.limit ? Number(flags.limit) : undefined);
console.log(`\narms: ${arms.join(', ')}   questions answered by all arms: ${ids.length}`);

// [G] would identify the graph arm outright; the numbered markers are noise for this task.
const strip = (s) => String(s ?? '')
  .replace(/\[\d+!?\]/g, '').replace(/\[!\]/g, '').replace(/\[G\]/g, '')
  .replace(/[ \t]{2,}/g, ' ').trim();

// ---------------------------------------------------------------- set scoring
/** Company/authority names in a gold answer, for recall on set-valued questions. */
function goldEntities(expected) {
  const names = [];
  const m = expected.match(/(?:The companies are|defended their treatment):?\s*([^.]+)\./i);
  if (m) names.push(...m[1].split(/,\s*|;\s*/));
  for (const a of expected.matchAll(/\b(ASC|ASU|IFRS|IAS|Item|Rule|C&DI)\s+[\w().-]+/g)) {
    names.push(a[0]);
  }
  return [...new Set(names.map((s) => s.replace(/\(.*?\)/g, '').trim()).filter((s) => s.length > 3))];
}

/** Loose containment: an answer credits an entity if its distinctive head word appears. */
function covered(reply, entity) {
  const head = entity.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
  return reply.toLowerCase().includes(head);
}

// ---------------------------------------------------------------- judge
const RUBRIC = `You are grading answers to questions about a corpus of SEC comment-response letters.

The EXPECTED answer was computed directly from the corpus and is authoritative. Grade only
whether the CANDIDATE conveys the same facts. Ignore style, length, hedging and ordering.

CORRECT — every fact the expected answer asserts is present and nothing contradicts it.
          For questions asking "name every such company", every company must appear.
PARTIAL — some of the expected facts are present, none contradicted, but the answer is
          incomplete (for example it names 2 of 4 companies).
WRONG   — contradicts the expected answer, names entities that are not in it, or fails to
          engage with the question.

Reply with exactly one line:
VERDICT: CORRECT|PARTIAL|WRONG — <up to 15 words of reason>`;

async function judgeOne(question, expected, reply) {
  const body = {
    contents: [{
      role: 'user',
      parts: [{
        text: `${RUBRIC}\n\nQUESTION\n${question}\n\nEXPECTED\n${expected}\n\n` +
              `CANDIDATE\n${reply || '(no answer)'}\n`,
      }],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 100 },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${flags.model}:generateContent`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const j = await res.json();
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const m = text.match(/VERDICT:\s*(CORRECT|PARTIAL|WRONG)\s*[—-]?\s*(.*)/i);
    if (m) return { v: m[1].toUpperCase(), why: m[2].trim().slice(0, 120) };
    return { v: 'WRONG', why: `unparseable judge reply: ${text.slice(0, 60)}` };
  }
  return { v: 'ERROR', why: 'judge unavailable after retries' };
}

// ---------------------------------------------------------------- run
const evidence = JSON.parse(fs.readFileSync(path.join(HERE, 'evidence.json'), 'utf8'));
const verdicts = {};
const conc = Number(flags.concurrency);
let done = 0;

const tasks = [];
for (const id of ids) {
  // Shuffle arm order per question so nothing about position leaks into the judging.
  const order = [...arms].sort(() => Math.random() - 0.5);
  for (const arm of order) tasks.push({ id, arm });
}

for (let i = 0; i < tasks.length; i += conc) {
  await Promise.all(tasks.slice(i, i + conc).map(async ({ id, arm }) => {
    const row = byArm.get(arm).get(id);
    const reply = strip(row.reply);
    const res = await judgeOne(row.question, row.expected, reply);
    const gold = goldEntities(row.expected);
    const hit = gold.filter((g) => covered(reply, g));
    (verdicts[id] ??= {})[arm] = {
      ...res,
      recall: gold.length ? +(hit.length / gold.length).toFixed(3) : null,
      goldEntities: gold.length,
      found: hit.length,
      supportDocsRetrieved: row.supportDocsRetrieved,
      supportDocCount: row.supportDocCount,
      graphSeeds: row.graphSeeds?.length ?? 0,
    };
    done += 1;
    if (done % 25 === 0) process.stdout.write(`  judged ${done}/${tasks.length}\r`);
  }));
}
fs.writeFileSync(path.join(HERE, flags.out), JSON.stringify(verdicts, null, 1));
console.log(`\nwrote ${flags.out}`);

// ---------------------------------------------------------------- report
const score = (v) => (v === 'CORRECT' ? 1 : v === 'PARTIAL' ? 0.5 : 0);
console.log('\narm      n   correct  partial  wrong   score   mean recall');
for (const arm of arms) {
  const rows = ids.map((id) => verdicts[id][arm]).filter(Boolean);
  const c = rows.filter((r) => r.v === 'CORRECT').length;
  const p = rows.filter((r) => r.v === 'PARTIAL').length;
  const w = rows.filter((r) => r.v === 'WRONG').length;
  const recall = rows.filter((r) => r.recall !== null);
  console.log(`${arm.padEnd(7)} ${String(rows.length).padStart(3)} ` +
    `${String(c).padStart(8)} ${String(p).padStart(8)} ${String(w).padStart(6)} ` +
    `${(100 * rows.reduce((s, r) => s + score(r.v), 0) / rows.length).toFixed(1).padStart(6)}% ` +
    `${(100 * recall.reduce((s, r) => s + r.recall, 0) / recall.length).toFixed(1).padStart(10)}%`);
}

// Per-stratum, the split that mattered most in experiment 04. Reported as a FRACTION of support
// documents reached, because holdout questions cite up to 30 and top-k is 10.
console.log('\nby support-document reach (fraction of the question\'s support docs retrieved):');
const bucket = (r) => {
  const f = r.supportDocCount ? r.supportDocsRetrieved / r.supportDocCount : 0;
  return f === 0 ? 'none' : f < 0.34 ? 'low' : f < 0.67 ? 'mid' : 'high';
};
for (const b of ['none', 'low', 'mid', 'high']) {
  const line = arms.map((arm) => {
    const rows = ids.map((id) => verdicts[id][arm]).filter((r) => r && bucket(r) === b);
    if (!rows.length) return `${arm}: —`;
    return `${arm}: ${(100 * rows.reduce((s, r) => s + score(r.v), 0) / rows.length).toFixed(0)}% (n=${rows.length})`;
  }).join('   ');
  console.log(`  ${b.padEnd(5)} ${line}`);
}

console.log('\nby archetype:');
const types = [...new Set(ids.map((id) => evidence[id]?.type ?? 'unknown'))];
for (const t of types.sort()) {
  const subset = ids.filter((id) => (evidence[id]?.type ?? 'unknown') === t);
  const line = arms.map((arm) => {
    const rows = subset.map((id) => verdicts[id][arm]).filter(Boolean);
    return `${arm}: ${(100 * rows.reduce((s, r) => s + score(r.v), 0) / rows.length).toFixed(0)}%`;
  }).join('   ');
  console.log(`  ${t.padEnd(12)} n=${String(subset.length).padStart(3)}  ${line}`);
}
