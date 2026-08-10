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

## 4. Synthesis benchmark — the knowledge graph does help, by 8 answers in 200

`Synthesis benchmark/` runs the experiment the ablation above could not: can OpenCrawl reproduce the
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

The two arms are collection 26 and collection 33, a row-for-row clone with `knowledgeGraph` left
null. Verified before running: retrieval returns **identical chunk ids in identical order**, and the
graph supplies facts on 20/20 sampled questions in 26 and 0/20 in 33.

### Result — 400 answers, every one read and judged by hand

| collection | CORRECT | PARTIAL | WRONG | accuracy |
| --- | --- | --- | --- | --- |
| 26 — graph (20,301 entities) | 128 | 52 | 20 | **64.0%** |
| 33 — no graph (control) | 120 | 56 | 24 | **60.0%** |

**+8 answers, +4.0 points.** 16 of 200 questions were graded differently between the arms. Against
the previous ablation's 1-answer spread over 660, this is a real effect.

**The graph fired on every question**: facts were supplied for 200/200, and the model cited `[G]` in
76 of them — against 5 of 220 in the toxicology ablation. Splitting by whether the graph actually
contributed:

| | questions | c26 | c33 |
| --- | --- | --- | --- |
| graph facts supplied **and** cited `[G]` | 76 | **64.5%** | 59.2% |
| supplied but not cited | 124 | **63.7%** | 60.5% |
| not supplied | 0 | — | — |

The effect is larger where the model actually used a graph fact, which is what you would expect if
the graph is doing the work rather than the difference being noise.

### What the graph actually contributes

Every flip has the same shape: **the control arm denies the corpus contains something the graph
knew.** Retrieval is bit-identical, so the difference cannot come from anywhere else.

| | control arm (no graph) | graph arm |
| --- | --- | --- |
| Q038 | "the corpus does not mention a dataset named MP-20" | answered from a `[G]` fact that MP-20 is a Materials Project subset |
| Q015 | "does not state that WyckoffDiff and WyCryst build on the same representation" | correct |
| Q189 | "does not contain information regarding models evaluated on MP-20" | named CDVAE from a graph fact |
| Q081 | "no general claim that NequIP challenges" | answered it |
| Q094 | declined to explain why disordered training helps | correct |
| Q107 | treated two XRD papers as one study | contrasted them |

Two flips ran the other way (Q139, Q147), where the graph arm declined and the control arm answered.
The net is +8.

### The binding constraint is retrieval, not synthesis

Almost every WRONG verdict in either arm coincides with **0 of N support documents retrieved** at
top-k 10. Since retrieval is identical in both arms this affects them equally, but it caps how high
either can score — and it is the largest available lever on this benchmark, well ahead of the graph.

### Two errors found in the reviews, and two in our own questions

Verifying claims against the corpus caught the reviews misreporting their own sources:

- Review B's Table 6 credits the autonomous laboratory with **41 of 58** targets in 17 days. The cited
  paper says **36 of 57**, a 63% success rate.
- Review B says ElemNet trained on **275,000** OQMD compounds; the paper says **256,622**.

And two of our own expected answers were wrong, both graded in the model's favour and recorded in
`verdicts.synthesis.json`: Q019 inherited review B's ElemNet figure, and Q134 used our arithmetic
(21 unobtained targets) where the paper says 17.

---


## Layout

| path | what it is |
| --- | --- |
| `main.js` | benchmark harness — retrieval-only by default, `--answers` for the full RAG path |
| `Synthesis benchmark/` | review PDFs, reference reports, question sources and the verifying builder |
| `grading_results.txt` | 220 answers, collection 28, graded by hand |
| `ablation_grading.txt` | 660 answers, collections 30/31/32, graded by hand |
| `benchmark_*.txt/.jsonl` | answer runs |
| `retrieval_*.txt` | retrieval runs (chunk metadata; the `.jsonl` sidecars are gitignored) |

Corpus PDFs are deliberately not committed — this repository is public and the documents are
third-party. `retrieval_*.jsonl` is gitignored for the same reason: it embeds the full text of every
retrieved chunk.
