/**
 * dedup.mjs — find questions that are the same question wearing different words.
 *
 * Reading the candidates by hand surfaced three duplicate families that no amount of care will
 * catch reliably by memory across 240 items, and each of them inflates the apparent size of the
 * benchmark without adding a single new measurement:
 *
 *   ORDER SWAP     compare/shared generate pairs twice (the rotation added to raise yield), so
 *                  "A and B" and "B and A" both appear on the same hub with the same documents.
 *   INVERSE PAIR   a `shared` question asks which authority two filers both cited; a `set`
 *                  question asks which filers cited that authority. Same two documents, same
 *                  fact, stated forwards and backwards.
 *   PARENT CODE    ASC 605-25 and ASC 605-25-25, Item 404(b) and Item 404(b)(1) -- the regex
 *                  captures both the parent and the child, so one citation becomes two hubs
 *                  with identical filers and identical answers.
 *
 * Reported, not auto-applied: this proposes rejects and prints them for a decision. Questions
 * already reviewed by hand are listed separately so a machine rule never silently overrides a
 * judgement that was made by reading.
 *
 * Run:  node dedup.mjs [--emit]      --emit prints a record payload for the unreviewed ones
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const candidates = JSON.parse(fs.readFileSync(path.join(HERE, 'raw', 'candidates.json'), 'utf8'));
const reviewPath = path.join(HERE, 'raw', 'review.json');
const review = fs.existsSync(reviewPath) ? JSON.parse(fs.readFileSync(reviewPath, 'utf8')) : {};

const byId = new Map(candidates.map((q) => [q.id, q]));
const docsKey = (q) => [...q.supportDocIds].sort().join('|');

/** Authority codes where one string is a prefix of the other: "ASC 605-25" vs "ASC 605-25-25". */
const isParentCode = (a, b) => {
  if (a === b) return false;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return l.startsWith(s) && /^[-(]/.test(l.slice(s.length));
};

const dupes = new Map();                 // loser id -> {reason, winner}
const flag = (loser, winner, reason) => {
  if (loser === winner || dupes.has(loser)) return;
  dupes.set(loser, { winner, reason });
};

// --- order swap: same archetype, same hub, same set of filers ---------------------------------
const swapSeen = new Map();
for (const q of candidates) {
  if (!['compare', 'shared'].includes(q.type)) continue;
  const key = `${q.type}|${q.hub}|${[...q.supportFilers].sort().join(',')}`;
  if (swapSeen.has(key)) flag(q.id, swapSeen.get(key), 'order-swapped duplicate');
  else swapSeen.set(key, q.id);
}

// --- inverse pair: `shared` answer names the authority a `set` question is keyed on ------------
const setsByDocs = new Map();
for (const q of candidates) {
  if (q.type !== 'set') continue;
  const k = docsKey(q);
  if (!setsByDocs.has(k)) setsByDocs.set(k, []);
  setsByDocs.get(k).push(q);
}
for (const q of candidates) {
  if (q.type !== 'shared') continue;
  for (const s of setsByDocs.get(docsKey(q)) ?? []) {
    // the shared question's gold is "Both cited X"; the set question's hub IS X
    if (q.expectedAnswer.includes(s.hub)) flag(s.id, q.id, 'inverse duplicate of a shared question');
  }
}

// --- parent/child authority codes over identical documents ------------------------------------
const byDocs = new Map();
for (const q of candidates) {
  const k = `${q.type}|${docsKey(q)}`;
  if (!byDocs.has(k)) byDocs.set(k, []);
  byDocs.get(k).push(q);
}
for (const group of byDocs.values()) {
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const [a, b] = [group[i], group[j]];
      if (isParentCode(a.hub, b.hub)) {
        // keep the more specific code -- it is the one the letter actually cited
        const [loser, winner] = a.hub.length < b.hub.length ? [a, b] : [b, a];
        flag(loser.id, winner.id, 'parent/child authority code over identical documents');
      } else if (a.hub === b.hub) {
        flag(b.id, a.id, 'identical hub and documents');
      }
    }
  }
}

// --- report -----------------------------------------------------------------------------------
const unreviewed = [];
const conflictsKeep = [];
for (const [id, { winner, reason }] of [...dupes].sort()) {
  const v = review[id]?.v;
  if (!v) unreviewed.push([id, winner, reason]);
  else if (v === 'keep') conflictsKeep.push([id, winner, reason]);
}

console.log(`candidates            : ${candidates.length}`);
console.log(`duplicate groups found: ${dupes.size}`);
console.log(`  already rejected    : ${dupes.size - unreviewed.length - conflictsKeep.length}`);
console.log(`  not yet reviewed    : ${unreviewed.length}`);
console.log(`  ALREADY KEPT (conflict, decide by hand): ${conflictsKeep.length}`);

if (conflictsKeep.length) {
  console.log('\nkept but flagged as duplicate:');
  for (const [id, winner, reason] of conflictsKeep) {
    console.log(`  ${id} <- dup of ${winner}  (${reason})`);
    console.log(`     ${byId.get(id).question.slice(0, 110)}`);
  }
}
if (unreviewed.length) {
  console.log('\nunreviewed duplicates:');
  for (const [id, winner, reason] of unreviewed) {
    console.log(`  ${id} <- dup of ${winner}  (${reason})`);
  }
}

if (process.argv.includes('--emit')) {
  const payload = Object.fromEntries(unreviewed.map(([id, winner, reason]) =>
    [id, { v: 'reject', why: `duplicate: ${reason}` }]));
  fs.writeFileSync(path.join(HERE, 'raw', 'dedup_payload.json'), JSON.stringify(payload, null, 1));
  console.log(`\nwrote raw/dedup_payload.json (${Object.keys(payload).length} rejects)`);
}
