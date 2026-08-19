/**
 * probe_graph.mjs — does the knowledge graph reach the support documents? No LLM.
 *
 * The counterpart to probe_retrieval.mjs, and the checkpoint that decides whether the benchmark
 * run is worth paying for. Chunk retrieval reached a support document on 60% of questions and on
 * only 38% of the aggregation archetypes, because the discriminating token in those questions is
 * a digit string ("ASC 605-25-25") mean-pooled against 26 words of identical template.
 *
 * The graph does not have that failure mode. matchSeeds (graph_retriever.js:184) resolves query
 * entities by GAZETTEER — exact n-gram lookup against every entity name and cluster alias — with
 * the embedding fallback off by default. An accounting-standard code either is a key or it is not;
 * no vector arithmetic is involved. That is the specific mechanism by which the graph could beat
 * chunk retrieval here, and it is checkable before spending anything on answers.
 *
 * Three ways it can still fail, each measured separately below rather than folded into one number:
 *   1. the hub was never extracted as an entity        -> seeds = 0, nothing to expand from
 *   2. the hub seeds but MIN_SEED_DOC_FREQ=2 drops it  -> matched but filtered, reported apart
 *   3. facts come back but from the wrong documents    -> reach = 0 despite a healthy fact count
 *
 * MAX_FACTS=25 is the cap that matters for the set/count archetypes: a question needing six
 * companies can lose them to twenty-five facts about one. So doc reach is reported at the default
 * cap and again uncapped, and the difference is the cost of the cap alone.
 *
 * Run:  node probe_graph.mjs --collection 35
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OPENCRAWL = process.env.OPENCRAWL_DIR ?? path.resolve(ROOT, '..', 'OpenCrawl');

const { values: flags } = parseArgs({
  options: { collection: { type: 'string' }, dump: { type: 'string', default: '6' } },
});
if (!flags.collection) { console.error('--collection <id> required'); process.exit(1); }

const require = createRequire(path.join(OPENCRAWL, 'package.json'));
require('dotenv').config({ path: path.join(OPENCRAWL, '.env') });
const { buildGraphIndex, graphFacts, matchSeeds, resolutionKey } = await import(
  pathToFileURL(path.join(OPENCRAWL, 'backend', 'retriever', 'graph_retriever.js')).href);
const { prisma } = await import(pathToFileURL(path.join(OPENCRAWL, 'backend', 'db.js')).href);

const col = await prisma.collection.findUnique({
  where: { id: Number(flags.collection) }, select: { id: true, name: true, knowledgeGraph: true },
});
const graph = col?.knowledgeGraph;
if (!graph) { console.error(`collection ${flags.collection} has no graph`); process.exit(1); }

const index = buildGraphIndex(graph);
console.log(`collection ${col.id} "${col.name}"`);
console.log(`graph      : ${graph.entities.length} entities, ${graph.relations.length} relations`);
console.log(`gazetteer  : ${index.keyToEntity.size} lookup keys over ${index.documentCount} docs`);
console.log(`env        : MIN_SEED_DOC_FREQ=${process.env.GRAPH_MIN_SEED_DOC_FREQ ?? 2} ` +
  `HUB_DOC_FREQ=${process.env.GRAPH_HUB_DOC_FREQ ?? 20} ` +
  `MAX_FACTS=${process.env.GRAPH_MAX_FACTS ?? 25} HOPS=${process.env.GRAPH_HOPS ?? 2}\n`);

const questions = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8'));
const evidence = JSON.parse(fs.readFileSync(path.join(HERE, 'evidence.mapped.json'), 'utf8'));

// The graph's relationDocIds must live in the same id space as the mapped evidence, or every
// overlap silently reads zero -- the exact join error map_evidence.mjs exists to prevent.
const graphDocIds = new Set(graph.relationDocIds?.flat() ?? []);
const evidenceDocIds = new Set(Object.values(evidence).flatMap((e) => e.supportDocIds));
const shared = [...evidenceDocIds].filter((d) => graphDocIds.has(d)).length;
console.log(`id-space check: ${shared}/${evidenceDocIds.size} support docIds appear in ` +
  `relationDocIds  ${shared === 0 ? '<-- JOIN IS BROKEN, numbers below are meaningless' : 'ok'}\n`);

const rows = [];
for (const q of questions) {
  const ev = evidence[q.id];
  const { seeds: rawSeeds } = matchSeeds(q.question, index);
  const kept = rawSeeds.filter((e) => (index.docsOf.get(e)?.size || 0) >= 2);

  // Is the question's own hub in the gazetteer at all? This separates "the graph never learned
  // this entity" from "the graph learned it but the ranking buried it".
  const hubKey = resolutionKey(ev.hub);
  const hubEntity = index.keyToEntity.get(hubKey) ?? null;
  const hubDf = hubEntity ? (index.docsOf.get(hubEntity)?.size || 0) : 0;

  const capped = graphFacts(q.question, index);
  const uncapped = graphFacts(q.question, index, { maxFacts: 100000 });
  const docsFrom = (f) => new Set(f.facts.flatMap((x) => x.docIds));
  const reach = (f) => ev.supportDocIds.filter((d) => docsFrom(f).has(d)).length;

  rows.push({
    id: q.id, type: q.type, hub: ev.hub, need: ev.supportDocIds.length,
    seeds: kept.length, seedNames: kept.slice(0, 6),
    hubMatched: !!hubEntity, hubEntity, hubDf,
    nFacts: capped.facts.length, nFactsUncapped: uncapped.facts.length,
    hit: reach(capped), hitUncapped: reach(uncapped),
    facts: capped.facts.slice(0, 8),
  });
}

const pct = (a, b) => `${(100 * a / Math.max(b, 1)).toFixed(0)}%`;
const types = [...new Set(rows.map((r) => r.type))].sort();

console.log('archetype      n   hub in KG   any seed   facts>0    any hit   mean recall   uncapped');
for (const t of [...types, 'ALL']) {
  const rs = t === 'ALL' ? rows : rows.filter((r) => r.type === t);
  const rec = rs.reduce((s, r) => s + r.hit / Math.max(r.need, 1), 0) / rs.length;
  const recU = rs.reduce((s, r) => s + r.hitUncapped / Math.max(r.need, 1), 0) / rs.length;
  console.log(`  ${t.padEnd(12)} ${String(rs.length).padStart(3)} ` +
    `${pct(rs.filter((r) => r.hubMatched).length, rs.length).padStart(10)} ` +
    `${pct(rs.filter((r) => r.seeds > 0).length, rs.length).padStart(10)} ` +
    `${pct(rs.filter((r) => r.nFacts > 0).length, rs.length).padStart(9)} ` +
    `${pct(rs.filter((r) => r.hit > 0).length, rs.length).padStart(10)} ` +
    `${(100 * rec).toFixed(0).padStart(12)}% ${(100 * recU).toFixed(0).padStart(10)}%`);
}

const noHub = rows.filter((r) => !r.hubMatched);
console.log(`\nhubs the graph never learned (${noHub.length}/${rows.length}):`);
for (const r of noHub.slice(0, 20)) console.log(`  ${r.id.padEnd(6)} ${r.type.padEnd(11)} ${r.hub}`);

const capCost = rows.filter((r) => r.hitUncapped > r.hit);
console.log(`\nquestions where MAX_FACTS=25 cost reach: ${capCost.length}`);
for (const r of capCost.slice(0, 10)) {
  console.log(`  ${r.id.padEnd(6)} ${r.type.padEnd(11)} ${String(r.hub).slice(0, 30).padEnd(31)} ` +
    `${r.hit} -> ${r.hitUncapped} of ${r.need}   (${r.nFacts} of ${r.nFactsUncapped} facts kept)`);
}

console.log(`\n--- sample facts (${flags.dump} questions) ---`);
for (const r of rows.filter((x) => x.nFacts > 0).slice(0, Number(flags.dump))) {
  console.log(`\n${r.id} [${r.type}] hub="${r.hub}"  seeds=${JSON.stringify(r.seedNames)}`);
  console.log(`  reached ${r.hit}/${r.need} support docs from ${r.nFacts} facts`);
  for (const f of r.facts) {
    console.log(`    ${f.subject} -[${f.predicate}]-> ${f.object}   (${f.docIds.length} doc)`);
  }
}

fs.writeFileSync(path.join(HERE, 'raw', `graph_probe_${col.id}.json`),
  JSON.stringify(rows, null, 1));
console.log(`\nwrote raw/graph_probe_${col.id}.json`);
await prisma.$disconnect();
