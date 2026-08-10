# OpenCrawl-Benchmarks

Benchmarks for the accuracy and impact of OpenCrawl's RAG stack — retrieval, clustering, BM25,
knowledge-graph generation and claim verification.

Everything below was measured against a live OpenCrawl instance. Each number names the artifact it
came from, and every accuracy figure was produced by reading the answers individually, not by
pattern matching.

---

## 1. Retrieval could not find the document a question named

Benchmark A (collection 28, 20 toxicology reports, 1008 chunks, 220 questions of the form
`regarding <study>, answer the following: <prompt>`) started at **10.5%** of retrieved chunks coming
from the study the question named, **53%** of questions retrieving nothing at all from their own
study, and retrieval only **2.09×** better than picking chunks at random.

The cause was that no document-identity signal reached the retriever:

- `tokenise()` matches `[a-z]+`, so digits are discarded — `1.1 Dermal_sens.pdf` and
  `2.10 Dermal_sens.pdf` both reduce to `["dermal","sens","pdf"]`.
- Filenames are not part of chunk text: the tokens `sens`, `geno` and `repd` appear in **0 of 1008**
  chunks.
- The vector channel is topical, and the corpus is 5× dermal sensitisation, 6× in-vitro genotox.
- `retrieve()` had no document filter or boost.

**Fix** (`RETRIEVER_DOC_BOOST`, default 2.0, in the OpenCrawl repo): resolve document names from the
query text and multiply them into the existing per-document boost.

| | before | after |
| --- | --- | --- |
| retrieved chunks from the named study | 10.5% | **74.7%** |
| questions retrieving nothing from their study | 53% | **1%** |
| questions with the target document at rank 1 | 22 / 220 | **212 / 220** |

Queries that name no document are bit-identical to before. Answer accuracy on the same 220
questions: **163/220 = 74.1%** (`grading_results.txt`).

---

## 2. The knowledge-graph ablation was null — and the reason is mechanical

Collections 30/31/32 share the same 20 documents, the same 1008 chunks and the same embeddings, so
chunk retrieval is identical and the graph is the only variable (`ablation_grading.txt`, 660 answers
graded by hand in batches of 11).

| collection | graph | correct | accuracy |
| --- | --- | --- | --- |
| 30 | none | 163 / 220 | 74.1% |
| 31 | whole corpus (1610 entities / 880 relations) | 163 / 220 | 74.1% |
| 32 | random 40% (1180 entities / 675 relations) | 162 / 220 | 73.6% |

One answer of spread across 660; **215 of 220 questions got the same verdict in all three arms**.

That is not evidence the graph does not help. The graph **never fired**:

| answers containing a `[G]` graph-sourced claim | |
| --- | --- |
| collection 30 | 0 / 220 |
| collection 31 | **5 / 220** |
| collection 32 | 0 / 220 |

`graph_retriever.js` requires `GRAPH_MIN_SEED_DOC_FREQ = 2` — an entity appearing in only one
document can never seed a query. In collection 31's graph:

| entity document frequency | count | share |
| --- | --- | --- |
| 1 document → rejected as a seed | 912 | **94.0%** |
| 2–19 documents → usable seed | 58 | 6.0% |
| 20+ documents → hub, seed only | 0 | 0% |

In a 20-document corpus where every study is about a different substance, almost every entity is
document-unique. **The experiment could not have detected an effect of any size.**

---

## 3. What a corpus needs before it can test a knowledge graph

The criterion falls straight out of the above: **entities must recur across documents, concentrated
in the 2–19 document band**, joined by relations worth traversing two hops.

Collection 26 ("Materials Synthesis", 192 papers, 16,272 chunks) satisfies it; collection 31 does
not:

| entity document frequency | collection 26 (192 docs) | collection 31 (20 docs) |
| --- | --- | --- |
| 1 document → rejected as a seed | 13,813 (86.3%) | 912 (94.0%) |
| **2–19 → usable seed** | **2,176 (13.6%)** | 58 (6.0%) |
| 20+ → hub, seed only | 9 (0.1%) | 0 |

2,176 seedable entities against 58 — and the right kind: MatterGen (7 documents, 196 relations),
DiffCSP (9/155), CDVAE (11/119), NequIP (5/160), CGCNN (6/86), MP-20 (6/30), GNoME (3/41).

**This histogram is a cheap pre-flight test.** Build the graph, bin its entities by document
frequency, and if under ~20% land in the 2–19 band the graph will not fire often enough to measure,
however good it is. It costs seconds and would have predicted the null result above.

Assessed against that criterion, of the corpus types considered: **medical records** are the
strongest fit (drugs, conditions and procedures recur at the right frequency, relations are typed
and multi-hop questions are natural); **invoices** are weak (bimodal frequency — a few hub vendors
and a long single-document tail — and the value is in numbers, which triple extraction handles
worst); **call-centre procedures** are weakest (conditional prose does not decompose into triples,
and the useful retrieval is chunk retrieval).

---

## 4. Synthesis benchmark — the graph helps a little; the fact cap is not why

`experiments/03-synthesis/` runs the experiment the ablation above could not: can OpenCrawl reproduce the
conclusions of a review article from the primary papers that review cites?

Two review PDFs supply the ground truth; collection 26 — their downloaded reference lists — supplies
the evidence:

- **A** — *AI and Generative Models for Materials Discovery*, Handoko & Made, 26 pp, arXiv
  2508.03278, 141 references.
- **B** — *Machine Learning-Driven Materials Discovery*, Nematov & Hojamberdiev, 64 pp, arXiv
  2503.18975, 324 references.

Reference lists parse cleanly (A: 133 of 141; B: 322 of 324), and title matching maps **143 of
collection 26's 192 documents** to a numbered citation in one of the reviews.

**200 questions**, 40 single-document / 80 cross-document / 60 multi-hop / 20 enumerate. Ground truth
is each review's own claim; `build_questions.mjs` verifies **every component** of that claim against a
chunk of a cited collection-26 document — 508 components across 62 documents — and refuses to emit if
one cannot be found. It also enforces that every question seeds the graph and that none resolves a
document name, which would collect the 2.0x doc boost and turn synthesis into lookup.

The arms are collection 26 and collection 33, a row-for-row clone with `knowledgeGraph` left null.
Verified before running: retrieval returns **identical chunk ids in identical order**, and the graph
supplies facts on 20/20 sampled questions in 26 and 0/20 in 33. Retrieval does not depend on the
graph or on the fact cap, so it is identical across all three arms.

### Result — 600 answers, every one read and judged by hand

A third arm was added: the same collection 26, the same 200 questions, the same retrieval, with
`GRAPH_MAX_FACTS` raised from 25 to 100. All 600 answers were then re-read from scratch.

| arm | Correct | Partially Correct | False | accuracy |
| --- | --- | --- | --- | --- |
| `26@25` — graph, 25 facts | 106 | 73 | 21 | **53.0%** |
| `26@100` — graph, 100 facts | 107 | 70 | 23 | **53.5%** |
| `33` — no graph (control) | 101 | 73 | 26 | **50.5%** |

**The graph is worth 5–6 answers in 200. Widening its window is worth nothing.**

## 5. Why a bigger fact window does not help

`GRAPH_MAX_FACTS = 25` looked like the binding constraint. Measured over all 200 questions
against the real graph index, 2-hop expansion reaches a **median of 705 facts** per question
(mean 932, max 3321); only 5 questions have 25 or fewer. The model was seeing about **3%** of
what the graph found, and raising the cap demonstrably surfaces on-target facts — the share of
the 423 support documents touched by at least one fact in the window:

| cap | support documents reached | graph block |
| --- | --- | --- |
| 25 | 181 / 423 — 42.8% | ~280 tok |
| **100** | **243 / 423 — 57.4%** | ~1,100 tok |
| 400 | 267 / 423 — 63.1% | ~3,900 tok |

At cap 100 the model demonstrably used the wider window — mean facts supplied rose 24.6 → 94.4
and `[G]` citations rose **76 → 89 of 200**. The window was verified end to end before the run:
on Q178 the model cited `[G]` for "MTP is used to approximate density functional theory", a
triple ranked **100th**, with no MTP triple anywhere in the top 25.

It changed the score by one answer.

| | |
| --- | --- |
| verdicts changed by the cap alone | 15 of 200 |
| improved | 7 |
| regressed | 8 |

Seven questions got better and eight got worse. More of the graph reaches the model, the model
cites it more often, and the answers are no better. **The 25-fact cap was not the constraint.**

### The binding constraint is retrieval, and it is absolute

| support documents retrieved | n | `26@25` | `26@100` | `33` |
| --- | --- | --- | --- | --- |
| all | 57 | 73.7% | 71.9% | 68.4% |
| some | 114 | 56.1% | 57.0% | 54.4% |
| **none** | **29** | **0.0%** | **3.4%** | **0.0%** |

Of the 29 questions where retrieval returned none of the supporting documents, the graph arms got
**one** right between them. A hundred graph facts cannot substitute for a missing chunk.

The cleanest illustration is a fact the benchmark asks for twice. Q153 and Q012 both want CDVAE's
encoder and decoder parameter counts. Q153 retrieves its one support document and all three arms
answer "2.2 million and 2.3 million" correctly. Q012 retrieves none, and all three arms answer
that the corpus does not state them.

Accuracy also falls off sharply with the number of documents a question needs — 85% single-document,
56% cross-document, 42–47% multi-hop, **5–10% enumerate**. The enumerate questions ask for
exhaustive lists; at top-k 10 the retriever cannot supply them, and the graph cannot either.

### Two errors found in the reviews, and three in our own questions

Verifying claims against the corpus caught the reviews misreporting their own sources:

- Review B's Table 6 credits the autonomous laboratory with **41 of 58** targets in 17 days. The
  cited paper says **36 of 57**, a 63% success rate.
- Review B says ElemNet trained on **275,000** OQMD compounds; the paper says **256,622**.

Three of our own questions were flawed and are recorded in `verdicts.synthesis.json`: Q019
inherited review B's ElemNet figure, Q134 used our arithmetic (21 unobtained targets) where the
paper says 17, and Q161 invented a "two failure modes" framing the source does not use. All are
graded in the model's favour.

### What to take from this

1. **The knowledge graph helps, by about 3 points, and the effect is real but small.** It is
   measurable here only because the corpus was chosen so the graph fires on every question.
2. **Showing the model more of the graph does not help.** The 25-fact window was not the limit;
   the model's ability to use loose triples is.
3. **Retrieval is the whole ballgame.** 29 questions score ~0% in every arm because the evidence
   never reaches the prompt. Fixing that is worth an order of magnitude more than any graph work.

**Caveat.** The reasoning model runs at temperature 0.2 with no seed and no replicate was run, so
a difference of a few answers is not separable from run-to-run variance. The 1-answer cap effect
is noise; the 5–6 answer graph effect and the 29-question retrieval collapse are not.

---

## Layout

| path | what it is |
| --- | --- |
| `main.js` | benchmark harness — retrieval-only by default, `--answers` for the full RAG path |
| `synthesis_benchmark.js` | the paired synthesis run: same questions, one collection per arm |
| `clone_collection.js` | row-for-row copy of a collection with `knowledgeGraph` left null |
| `experiments/01-doc-boost/` | retrieval before/after the doc boost, its answer run, `grading_results.txt` |
| `experiments/02-kg-ablation/` | collections 30/31/32, `ablation_grading.txt` (660 answers) |
| `experiments/03-synthesis/` | review PDFs, question sources, the verifying builder, three answer runs, `synthesis_grading.txt` (600 answers) |
| `runs/` | scratch output from a fresh run; promoted into `experiments/` once a report cites it |

Inside `experiments/03-synthesis/`: `build_questions.mjs` emits and verifies the question set,
`show_batch.mjs` prints a question with every arm's answer side by side for grading,
`record_verdicts.mjs` checkpoints hand verdicts into `verdicts.synthesis.json`, and
`grade_synthesis.mjs` renders the report — refusing to hide an ungraded answer, which would
otherwise count as correct.

Corpus PDFs are deliberately not committed — this repository is public and the documents are
third-party. `retrieval_*.jsonl` is gitignored for the same reason: it embeds the full text of every
retrieved chunk.
