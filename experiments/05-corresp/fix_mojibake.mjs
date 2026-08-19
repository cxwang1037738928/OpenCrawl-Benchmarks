/**
 * fix_mojibake.mjs — repair Windows-1252 characters that were never decoded to Unicode.
 *
 * edgartools returns filing text in which CP1252 punctuation (smart quotes, apostrophes, bullets,
 * dashes) arrives as raw bytes 0x91-0x97 read as Latin-1. Unicode reserves that range for C1
 * control characters, so nothing renders them: fpdf2 dropped them when building the PDFs -- the
 * "Font MPDFAA+Arial is missing the following glyphs" warning during build_corpus.py -- and
 * docling's extraction of those PDFs is consequently clean.
 *
 * The corpus is fine. The GOLD ANSWERS are not: they were built from the same source text and
 * still carry the raw bytes, so an expected answer reads
 *     Statement No. 48, Revenue Recognition When Right of Return Exists
 * where the indexed document says
 *     Statement No. 48, Revenue Recognition When Right of Return Exists
 *
 * That is what made a verbatim check of gold excerpts against the extracted corpus report 26%
 * missing when the content was present all along. Left unfixed it puts invisible control
 * characters in front of the judge and breaks any exact-match scoring.
 *
 * Repairs questions.json, evidence.json and raw/facts.json in place. The PDFs are NOT rebuilt --
 * they never contained these characters, so the indexed corpus needs nothing.
 *
 * Run:  node fix_mojibake.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');

// Escaped rather than literal: these characters are invisible in an editor and a literal class
// silently breaks under any re-encoding of this file.
const C1 = /[-]/g;

// The PDFs dropped these outright rather than substituting, so the corpus has no glyph at all
// where a quote belonged. The repair that makes gold match the indexed text is to drop the
// quote characters and keep the ones that carry meaning as proper Unicode.
const REPLACEMENT = {
  0x91: '', 0x92: '', 0x93: '', 0x94: '',      // ' ' " "  — dropped, as in the PDFs
  0x85: '...', 0x95: '•', 0x96: '–', 0x97: '—',
  0x99: '™', 0x8b: '‹', 0x9b: '›', 0x82: ',', 0x84: '"',
};

const fix = (s) => s.replace(C1, (ch) => REPLACEMENT[ch.charCodeAt(0)] ?? '');

const walk = (v) => {
  if (typeof v === 'string') return fix(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  }
  return v;
};

/** Count on the PARSED value, never the file text.
 *
 * Python writes facts.json with ensure_ascii=True, so a smart quote sits in the file as the six
 * literal characters , while Node's JSON.stringify leaves the same character as a raw byte
 * in questions.json. Counting file text reported 160 occurrences in one and zero in the other
 * for identical content. */
const countIn = (v) => {
  if (typeof v === 'string') return (v.match(C1) ?? []).length;
  if (Array.isArray(v)) return v.reduce((n, x) => n + countIn(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((n, x) => n + countIn(x), 0);
  return 0;
};

const TARGETS = ['questions.json', 'evidence.json', path.join('raw', 'facts.json')];
let grand = 0;
for (const rel of TARGETS) {
  const file = path.join(HERE, rel);
  if (!fs.existsSync(file)) { console.log(`${rel.padEnd(18)} (absent)`); continue; }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hits = countIn(parsed);
  const repaired = walk(parsed);
  const left = countIn(repaired);
  grand += hits;
  console.log(`${rel.padEnd(18)} found ${String(hits).padStart(5)}   remaining after fix ${left}`);
  if (!DRY && hits) fs.writeFileSync(file, JSON.stringify(repaired, null, 1));
}
console.log(`\n${DRY ? 'would repair' : 'repaired'} ${grand} characters` +
  (DRY ? '  (dry run — nothing written)' : ''));
