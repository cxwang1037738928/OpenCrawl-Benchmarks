/**
 * clone_collection.js — copy a collection's corpus into a new one, without its graph.
 *
 * The synthesis benchmark compares answers from a collection that HAS a knowledge graph
 * against one that does not. For that comparison to mean anything the two arms must
 * differ in the graph and in nothing else: same documents, same chunk boundaries, same
 * embeddings, same categories. Re-running the pipeline cannot promise that — docling
 * would re-extract ~4,700 pages and any drift in chunking would be indistinguishable
 * from a graph effect — so the corpus is copied row for row instead.
 *
 * What is NOT copied: knowledgeGraph, knowledgeGraphHtml and citationGraph. Chats are
 * not copied either; the harness makes its own.
 *
 * Chunks carry a 384-float embedding each and there are 16k of them in the source
 * collection, so they are streamed in pages rather than read into memory at once.
 *
 * Run:  node clone_collection.js --from 26 --name "Synthesis B — no graph"
 *   --from <id>       collection to copy            (required)
 *   --name <text>     name for the new collection   (required)
 *   --crawler <c>     sapphire | ruby | topaz       (default: same as source)
 *   --page-size <n>   chunks per read/write batch   (default 500)
 *   --dry-run         report what would be copied, write nothing
 *
 * Env: OPENCRAWL_DIR, DATABASE_URL (read from ../OpenCrawl/.env).
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OPENCRAWL = process.env.OPENCRAWL_DIR || path.resolve(ROOT, '..', 'OpenCrawl');

const { values: flags } = parseArgs({
  options: {
    from:        { type: 'string' },
    name:        { type: 'string' },
    crawler:     { type: 'string' },
    'page-size': { type: 'string' },
    'dry-run':   { type: 'boolean', default: false },
  },
});

const LOG = '[clone]';
const fail = (message) => { console.error(`${LOG} ${message}`); process.exit(1); };

const SOURCE_ID = Number(flags.from);
if (!Number.isInteger(SOURCE_ID)) fail('--from <collectionId> is required');
if (!flags.name?.trim()) fail('--name "<text>" is required');
const PAGE_SIZE = Number(flags['page-size'] ?? 500);

createRequire(path.join(OPENCRAWL, 'package.json'))('dotenv')
  .config({ path: path.join(OPENCRAWL, '.env') });
if (!process.env.DATABASE_URL) fail(`DATABASE_URL is not set (looked in ${path.join(OPENCRAWL, '.env')})`);

const { prisma } = await import(pathToFileURL(path.join(OPENCRAWL, 'backend', 'db.js')).href);

// Mirrors ORB_COLORS in backend/routes/collections.js, so a cloned collection gets a
// colour from the same palette the UI assigns.
const ORB_COLORS = ['#199e70', '#c98500', '#d55181', '#d95926', '#3987e5', '#008300', '#9085e9', '#e66767'];
const UPLOADS_DIR = path.resolve(OPENCRAWL, process.env.UPLOADS_DIR || 'uploads');

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

const source = await prisma.collection.findUnique({
  where: { id: SOURCE_ID },
  select: {
    id: true, name: true, crawler: true, userId: true,
    categories: true, docVectors: true, embeddingsMeta: true,
    knowledgeGraph: true, citationGraph: true,
  },
}).catch((err) => fail(`cannot reach Postgres — is it up? (${err.message})`));
if (!source) fail(`no collection ${SOURCE_ID}`);

const documents = await prisma.document.findMany({
  where: { collectionId: SOURCE_ID },
  orderBy: { createdAt: 'asc' },
});
const chunkCount = await prisma.chunk.count({ where: { collectionId: SOURCE_ID } });
if (!documents.length || !chunkCount) fail(`collection ${SOURCE_ID} has no indexed corpus to copy`);

const crawler = flags.crawler ?? source.crawler;
const graph = source.knowledgeGraph;

console.log(`${LOG} source: ${source.id} "${source.name}" (${crawler}, user ${source.userId})`);
console.log(`${LOG}         ${documents.length} documents, ${chunkCount} chunks`);
console.log(`${LOG}         graph: ${graph ? `${graph.entities?.length} entities / ${graph.relations?.length} relations — NOT copied` : 'none'}`);
console.log(`${LOG}         categories: ${source.categories ? `${source.categories.categories?.length} — copied` : 'none'}`);

if (flags['dry-run']) {
  console.log(`${LOG} dry run — nothing written`);
  await prisma.$disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

const existingCount = await prisma.collection.count({ where: { userId: source.userId } });
const clone = await prisma.collection.create({
  data: {
    name:    flags.name.trim(),
    crawler,
    color:   ORB_COLORS[existingCount % ORB_COLORS.length],
    userId:  source.userId,
    // Retrieval artifacts that are pure functions of the corpus come along, so the
    // keyword boost and the embedding map behave identically in both arms.
    categories:     source.categories     ?? undefined,
    docVectors:     source.docVectors     ?? undefined,
    embeddingsMeta: source.embeddingsMeta ?? undefined,
    // knowledgeGraph / knowledgeGraphHtml / citationGraph deliberately left null —
    // this is the one difference the benchmark is measuring.
  },
});
console.log(`${LOG} created collection ${clone.id} "${clone.name}"`);

// Documents first: Chunk.documentId references Document.id, which is a fresh cuid here.
const documentIdByDocId = new Map();
for (const doc of documents) {
  const created = await prisma.document.create({
    data: {
      docId:        doc.docId,
      collectionId: clone.id,
      filename:     doc.filename,
      // Rewritten to the clone's own upload directory; the files are copied below.
      filePath:     doc.filePath.replace(
        new RegExp(`([\\\\/])${SOURCE_ID}([\\\\/])`), `$1${clone.id}$2`),
      sha256:       doc.sha256,
      status:       doc.status,
      title:        doc.title,
      authors:      doc.authors,
      pageCount:    doc.pageCount,
      docling:      doc.docling ?? undefined,
      extractedAt:  doc.extractedAt,
    },
    select: { id: true },
  });
  documentIdByDocId.set(doc.docId, created.id);
}
console.log(`${LOG} copied ${documentIdByDocId.size} documents`);

// Chunks in pages: 16k rows each carrying 384 floats is more than is comfortable to
// hold at once, and createMany wants a bounded payload anyway.
let copied = 0;
for (let skip = 0; skip < chunkCount; skip += PAGE_SIZE) {
  const page = await prisma.chunk.findMany({
    where: { collectionId: SOURCE_ID },
    orderBy: [{ docId: 'asc' }, { chunkIndex: 'asc' }],
    skip,
    take: PAGE_SIZE,
  });
  await prisma.chunk.createMany({
    data: page.map((chunk) => ({
      chunkId:      chunk.chunkId,
      collectionId: clone.id,
      documentId:   documentIdByDocId.get(chunk.docId),
      docId:        chunk.docId,
      filename:     chunk.filename,
      chunkIndex:   chunk.chunkIndex,
      text:         chunk.text,
      heading:      chunk.heading,
      chunkType:    chunk.chunkType,
      sectionIndex: chunk.sectionIndex,
      pages:        chunk.pages ?? undefined,
      prefixLen:    chunk.prefixLen,
      category:     chunk.category,
      embedding:    chunk.embedding,
      ingestedAt:   chunk.ingestedAt,
    })),
  });
  copied += page.length;
  process.stdout.write(`\r${LOG} copied ${copied}/${chunkCount} chunks`);
}
console.log('');

// The uploaded PDFs, so the clone's document viewer works and filePath is not a lie.
const sourceUploads = path.join(UPLOADS_DIR, String(SOURCE_ID));
const cloneUploads  = path.join(UPLOADS_DIR, String(clone.id));
let filesCopied = 0;
try {
  await fs.mkdir(cloneUploads, { recursive: true });
  for (const entry of await fs.readdir(sourceUploads)) {
    await fs.copyFile(path.join(sourceUploads, entry), path.join(cloneUploads, entry));
    filesCopied++;
  }
  console.log(`${LOG} copied ${filesCopied} uploaded files -> uploads/${clone.id}/`);
} catch (err) {
  // Not fatal: retrieval reads chunks from Postgres, not from disk. Only the PDF
  // viewer needs these, so a missing uploads dir degrades the UI, not the benchmark.
  console.warn(`${LOG} warning: could not copy uploads (${err.message}) — retrieval is unaffected`);
}

// Last, because it is the retrieval cache key: setting it after the rows are in place
// means no reader can cache a half-populated corpus under the final stamp.
await prisma.collection.update({
  where: { id: clone.id },
  data:  { corpusUpdatedAt: new Date() },
});

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

const [cloneDocs, cloneChunks, cloneRow] = await Promise.all([
  prisma.document.count({ where: { collectionId: clone.id } }),
  prisma.chunk.count({ where: { collectionId: clone.id } }),
  prisma.collection.findUnique({
    where: { id: clone.id },
    select: { knowledgeGraph: true, citationGraph: true, categories: true, embeddingsMeta: true },
  }),
]);

const checks = [
  ['documents',      cloneDocs === documents.length, `${cloneDocs}/${documents.length}`],
  ['chunks',         cloneChunks === chunkCount,     `${cloneChunks}/${chunkCount}`],
  ['graph is null',  cloneRow.knowledgeGraph === null, String(cloneRow.knowledgeGraph === null)],
  ['citations null', cloneRow.citationGraph === null,  String(cloneRow.citationGraph === null)],
  ['categories',     Boolean(cloneRow.categories) === Boolean(source.categories), 'copied'],
  ['embeddingsMeta', Boolean(cloneRow.embeddingsMeta) === Boolean(source.embeddingsMeta), 'copied'],
];
console.log('');
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(16)} ${detail}`);
}
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${LOG} collection ${clone.id} ready${failed ? ` — ${failed} CHECK(S) FAILED` : ''}`);

await prisma.$disconnect();
process.exit(failed ? 1 : 0);
