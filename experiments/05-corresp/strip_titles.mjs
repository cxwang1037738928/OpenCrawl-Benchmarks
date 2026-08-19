/**
 * strip_titles.mjs — remove the injected document title from the chunk prefixes, without docling.
 *
 * build_corpus.py rendered every letter with a title line, "AMGN — SEC correspondence,
 * 2007-10-15". docling made that the document title, and chunker.js:195-199 prefixes every chunk
 * with "title — heading":
 *
 *     const title = entry.metadata?.title || '';
 *     const prefixParts = [title, unit.heading].filter(Boolean);
 *     const prefix = prefixParts.length ? `${prefixParts.join(' — ')}\n` : '';
 *
 * The result was 86% of 4,260 chunks starting with that line and 87% containing the words "SEC
 * correspondence" -- which every question in this benchmark also contains. That adds a large,
 * uniform similarity component to nearly every chunk and puts each company's ticker on every one
 * of its chunks, so a question naming a company matched its letterheads and sign-offs as readily
 * as its arguments. 88% of the chunks retrieved from a support document were boilerplate.
 *
 * Re-running docling is unnecessary to fix it. The chunker reads doclings.json, which
 * exportDoclings writes from the Document.docling column -- not from the PDFs. Clearing
 * metadata.title there and re-running the embed stage re-chunks and re-embeds from the same
 * extracted text. The PDFs are never reopened.
 *
 * The heading half of the prefix is deliberately kept. chunker.js documents it as measurably
 * helping retrieval for heading-shaped queries, and it is per-section rather than per-document,
 * so it discriminates instead of drowning.
 *
 * Run:  node strip_titles.mjs --collection 34 [--dry-run] [--restore-from backup]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');

const { values: flags } = parseArgs({
  options: {
    collection: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!flags.collection) { console.error('--collection <id> required'); process.exit(1); }
const ID = Number(flags.collection);

const require = createRequire(path.join(OPENCRAWL, 'package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(OPENCRAWL, '.env'), 'utf8'));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL ?? process.env.DATABASE_URL } },
});

const docs = await prisma.document.findMany({
  where: { collectionId: ID },
  select: { id: true, filename: true, title: true, docling: true },
});
console.log(`documents in collection ${ID}: ${docs.length}`);

// Only the title this experiment injected. A title docling found inside the letter is left alone:
// it is real content, and removing it would change what the corpus says.
const INJECTED = /^[A-Z]{2,5}\s*[—-]\s*SEC correspondence,\s*\d{4}-\d{2}-\d{2}$/;

let cleared = 0, kept = 0, headings = 0, docsWithHeading = 0;
const backup = {};
for (const d of docs) {
  const entry = d.docling;
  if (!entry) { kept += 1; continue; }
  let changed = false;
  const next = { ...entry };

  const t = entry.metadata?.title;
  if (t && INJECTED.test(String(t).trim())) {
    backup[d.id] = { title: t };
    next.metadata = { ...entry.metadata, title: '' };
    cleared += 1;
    changed = true;
  } else {
    kept += 1;
  }

  // The rendered title was also the first line of the page, so docling recorded it as a SECTION
  // HEADING as well as metadata. chunker.js prefixes each chunk with its heading, so clearing
  // the metadata alone left 1,659 chunks still carrying it -- 41% of the corpus rather than 87%.
  if (Array.isArray(entry.sections)) {
    const secs = entry.sections.map((s) => {
      if (s?.heading && INJECTED.test(String(s.heading).trim())) {
        headings += 1;
        changed = true;
        return { ...s, heading: '' };
      }
      return s;
    });
    if (changed) next.sections = secs;
    if (secs.some((s, i) => s !== entry.sections[i])) docsWithHeading += 1;
  }

  if (changed && !flags['dry-run']) {
    await prisma.document.update({ where: { id: d.id }, data: { docling: next } });
  }
}

console.log(`metadata titles cleared              : ${cleared}`);
console.log(`metadata titles left untouched       : ${kept}   (absent, or found inside the letter)`);
console.log(`section headings cleared             : ${headings}  across ${docsWithHeading} documents`);

if (flags['dry-run']) {
  console.log('\ndry run — nothing written');
} else {
  fs.writeFileSync(path.join(HERE, 'raw', 'title_backup.json'), JSON.stringify(backup, null, 1));
  console.log('\nwrote raw/title_backup.json (original titles, for reversal)');
  console.log('\nnext — re-chunk and re-embed from the same extracted text, no docling:');
  console.log(`  POST /collections/${ID}/pipeline/embed      { "force": true }`);
  console.log(`  POST /collections/${ID}/pipeline/categorize { "threshold": ${env.CATEGORIES_SIMILARITY || 0.65} }`);
  console.log(`  POST /collections/${ID}/pipeline/heuristic  { "k": 89 }`);
}
await prisma.$disconnect();
