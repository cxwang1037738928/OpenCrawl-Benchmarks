# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **measurement harness**, not a product. It drives a live OpenCrawl instance and reports how well
its RAG stack (retrieval, BM25, clustering, knowledge graph, claim verification) actually performs.
There is no application code, no test suite and no lint step — the deliverable is the numbers in
[README.md](README.md) and [experiments/RESULTS.md](experiments/RESULTS.md), and every one of them
names the artifact it came from.

Read [README.md](README.md) before changing anything under `experiments/`. It carries the findings
in full (six sections, four null results) and each experiment folder exists to support one of them.

## Hard prerequisites

Nothing here runs standalone:

- **A sibling OpenCrawl checkout** at `../OpenCrawl` (override with `OPENCRAWL_DIR`). Scripts import
  its real modules in-process — `backend/retriever/retriever.js`, `backend/retriever/graph_retriever.js`,
  `backend/db.js` — rather than reimplementing them, so a retrieval change over there shows up here
  immediately instead of silently drifting.
- **Its `.env`**, loaded via the sibling's own `dotenv` at import time. `DATABASE_URL` must resolve.
  Retrieval and graph knobs (`RETRIEVER_*`, `GRAPH_*`) are read into module constants **on first
  import**, so they must be set in the environment before the script starts, never mutated after.
- **Postgres** (the OpenCrawl compose stack) for anything that calls `retrieve()`.
- **A running backend** (`npm start` in OpenCrawl, not `npm run dev` — the watcher kills in-flight
  pipeline runs) plus a `REASONING_MODEL`, but only for the answer paths: `main.js --answers`,
  `synthesis_benchmark.js`, and experiment 05's `ingest.mjs` / `reindex.mjs` / `build_arms.mjs`.
- **`.venv/`** (local only, gitignored) for experiment 05's Python: `edgartools`, `fpdf2`, `bs4`.

[Specifications/API.md](Specifications/API.md) is the full HTTP reference for that backend — 30
endpoints verbatim from `backend/routes/*.js`, an end-to-end walkthrough, the env reference, and a
§6 list of 21 gotchas that will each cost a debugging session (`/pipeline/run` returns 200 on stage
failure; `build-graph` blocks for hours with no streaming; `POST /api/chats` rejects a string
`collectionId`).

## Commands

```bash
# Retrieval only — no LLM, no server, just Postgres + the sibling checkout.
node main.js --collection 28 --dry-run          # preflight + study to document match table
node main.js --collection 28                    # ranked chunks per question -> runs/retrieval_<stamp>.{txt,jsonl}
node main.js --collection 28 --studies 1.1,2.4 --limit 3   # narrow a smoke test
node main.js --collection 28 --answers          # full RAG path over HTTP; one model call per question

# Paired A/B answer run: same questions, one collection per arm.
BENCH=04-unbiased node synthesis_benchmark.js --collections 26,33
node synthesis_benchmark.js --ids Q001,Q005 --dry-run

# Row-for-row collection copy with knowledgeGraph left null (the control arm).
node clone_collection.js --from 26 --name "... — no graph" --dry-run

# Grading loop (serves any experiment via BENCH / QUESTIONS_FILE / EVIDENCE_FILE / VERDICTS_FILE).
node experiments/03-synthesis/show_batch.mjs 1 10                  # question + every arm's answer
node experiments/03-synthesis/record_verdicts.mjs --through Q050 < batch.json
node experiments/03-synthesis/grade_synthesis.mjs                  # -> synthesis_grading.txt
node experiments/04-unbiased/grade_v2.mjs                          # -> grading.v2.txt
node experiments/consolidate.mjs                                   # -> experiments/qa/*.json

# Experiment 05 reach probes — every §6 number, no LLM in the loop.
node experiments/05-corresp/probe_retrieval.mjs --collection 34 --n 84
node experiments/05-corresp/probe_graph.mjs --collection 35
node experiments/05-corresp/probe_querylen.mjs --collection 34
```

There is no single "run the benchmark" command and no smoke test that exercises the whole repo. Use
`--dry-run` (every entry point has one) and `--limit` / `--ids` / `--studies` as the fast path.

## Architecture

**Two entry points at the root, one per question shape.**

- [main.js](main.js) — study to target-document. 20 studies × 11 prompts, asked as
  `regarding <study>, answer the following: <prompt>`, and the report is *whether retrieval reached
  the document the question named*. Calls `retrieve()` in-process because `POST /chat` always
  synthesizes an answer, so retrieval cannot be observed alone over HTTP. `--answers` switches to the
  real HTTP path.
- [synthesis_benchmark.js](synthesis_benchmark.js) — paired arms, no target document. Questions name
  methods, not files, and most need several documents. Goes over HTTP because the graph reaches the
  model through `answer()`, not through chunk retrieval, so a retrieval-only run would measure
  nothing. Records `supportDocsRetrieved` and the graph seeds/facts per question — without those
  diagnostics a wrong answer caused by retrieval is indistinguishable from one caused by synthesis,
  which is why the first null ablation took a day to explain.

**Each `experiments/<nn>-<name>/` is one self-contained experiment** with the same file contract:

| file | role |
| --- | --- |
| `questions.json` | the asked set — id, question, expected answer |
| `evidence.json` | per question: support docIds, verifying quotes, measured strata |
| `verdicts.*.json` | hand verdicts, `C`/`P`/`F` plus a mandatory reason on P and F |
| `*grading*.txt` | the rendered report, regenerable from the two above |

Question **builders verify before they emit** and hard-fail rather than degrade:
`build_questions.mjs` refuses if any component of an expected answer has no literal chunk backing it,
if a question cannot seed the graph, or if it resolves a document name (which would collect the doc
boost and turn synthesis into lookup). `finalize.mjs` refuses if any candidate is unreviewed.

**Collection roster** (ids are load-bearing throughout the reports):

| id | corpus | graph |
| --- | --- | --- |
| 26 | Materials Synthesis, 192 papers / 16,272 chunks | yes |
| 28 | Benchmark A, 20 toxicology reports / 1,008 chunks | — |
| 30 / 31 / 32 | same 20 docs, ablation arms | none / full / random 40% |
| 33 | clone of 26 | none (control) |
| 34 / 35 | 221 SEC CORRESP letters / 4,091 chunks | none / `KG_FULL_TEXT_FRACTION=0.4` |
| 36 | same | **abandoned**, partial `complete: false` checkpoint — do not use |

## Invariants that are easy to break silently

- **Never run the knowledge-graph build stage.** `KG_MODEL` is `gemini/gemini-3.6-flash` and a build
  ran roughly 10M tokens. That means no `POST .../pipeline/build-graph`, no `build_arms.mjs` graph
  step, and no other path into `backend/extraction/kg_graph.py`. Use the graphs that already exist.
  Answering against a graph arm is safe — `graphFacts()` reads the stored graph in pure JS and chat
  uses `REASONING_MODEL`. State an estimated cost and get explicit approval before any run that
  spends tokens.
- **Embed queries with this repo's own MiniLM** (`Xenova/all-MiniLM-L12-v2`, mean pooling, L2
  normalized) — the model and pooling the corpus was built with. A different vector space retrieves
  badly without ever raising an error.
- **Grading is by hand, never by pattern matching**, and an ungraded answer is a hard failure in the
  report, not a warning. Absent-means-correct is the one bug these reports must not have.
- **Arms must differ in exactly one thing.** Clone collections row for row rather than re-running the
  pipeline; re-extraction drift is indistinguishable from a graph effect. Verify identical chunk ids
  in identical order before trusting a comparison.
- **Experiment 05 needs `EVIDENCE_FILE=evidence.mapped.json`** — the unmapped file keys on filenames
  while the retriever reports 16-hex docIds, so an unmapped run scores zero reach everywhere and the
  join error reads like a finding. It also needs `AUTH_AS_USER=1`: collections 34/35 belong to user 1
  (`admin@gmail.com`), unlike 02–04 which used user 7 (`demo@gmail.com`).
- **Differences under ~6 answers in 220 are noise.** The measured floor: 73 questions received a
  byte-identical prompt in two arms and 2 came back with different verdicts (temperature 0.2, no
  seed, no replicates).

## What must not be committed

This repository is public and the corpora are third-party. `.gitignore` carries the reasoning per
entry; the rule behind all of it is **chunk metadata is publishable, chunk text is not**. So
`retrieval_*.jsonl` (it embeds the full text of every retrieved chunk), `documents/`,
`experiments/05-corresp/corpus/`, `experiments/05-corresp/raw/` and `generated.raw.jsonl` stay local,
while the paired `.txt` reports, `questions.json`, `evidence.json` and the probe JSONs (with `text`
dropped and the §6 statistics precomputed as `hasLetterhead` / `hasTitlePrefix` flags) are committed.

`runs/` is scratch — both root entry points write every run there, and only the ones a report cites
get promoted into `experiments/<nn>-<name>/` and committed.
