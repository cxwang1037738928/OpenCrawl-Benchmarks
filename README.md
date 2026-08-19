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

### The +5 did not survive removing the question-set bias

Those 200 questions were generated *from the review PDFs*, which carried a retrieval bias into the
set. `experiments/04-unbiased/` rebuilt 220 questions sampled uniformly from document text, never
filtered on whether retrieval or the graph could answer them, and re-ran three arms — 660 answers,
all hand-graded (`grading.v2.txt`).

| arm | Correct | accuracy |
| --- | --- | --- |
| `26f2` — graph, seed floor 2 | 126 / 220 | **57.3%** |
| `26f1` — graph, seed floor 1 | 126 / 220 | **57.3%** |
| `33` — no graph (control) | 123 / 220 | **55.9%** |

**+3 answers, against a measured noise floor of ~6.** The floor is not an estimate: 73 questions
received a byte-identical fact window in the two graph arms — same prompt, two draws at temperature
0.2 — and 2 of the 73 came back with different verdicts. What did predict the answer was retrieval
reach, by 48 points in every arm. On the 8 questions where the graph reached the support document
and retrieval did not, all three arms scored 0 correct.

Full per-experiment tables are in [`experiments/RESULTS.md`](experiments/RESULTS.md); the
question/answer pairs behind every verdict are in [`experiments/qa/`](experiments/qa/).

---

## 6. Experiment 05 — a corpus built to pass the pre-flight test, which fails anyway

Experiments 02–04 all came back null on corpora chosen for topical breadth. `experiments/05-corresp/`
attacks the criterion from §3 directly: build a corpus that *satisfies* the entity-recurrence test,
ask only cross-document aggregation questions, and see whether the graph finally earns its keep.

The corpus is **221 SEC comment-response letters** (`CORRESP`) from **38 biotech filers**, fetched
from EDGAR, spanning 2004-12-10 to 2026-04-01, rendered to PDF and ingested to **4,091 chunks**.
Every letter is the same genre answering the same regulator, so accounting topics — revenue
recognition, R&D expense, non-GAAP measures, segment reporting — recur across filers by
construction. **183 hand-reviewed questions** in seven aggregation archetypes:

| archetype | n | what it asks |
| --- | --- | --- |
| `compare` | 101 | did two named filers take the same position on a topic |
| `set` | 30 | which filers were questioned about a topic |
| `recurring` | 14 | which topic the staff raised with a filer repeatedly |
| `conjunctive` | 13 | who conceded on one topic but defended another |
| `shared` | 11 | what two filers have in common |
| `holdout` | 8 | a topic deliberately held out of the seed set |
| `count` | 6 | how many filers were questioned about an authority |

Arms: **collection 34** (no graph) and **collection 35** (graph at `KG_FULL_TEXT_FRACTION=0.4`,
3,230 entities / 3,501 relations, 229 LLM calls, 1.73M tokens). A third arm at fraction `1.0` was
started and **abandoned on token cost**; its graph is a partial checkpoint (`complete: false`) and is
not used.

### There is no accuracy number for this experiment

The paired answer run died on provider rate limits at call 124 of 366 — 124 answers from the graph
arm, none from the control (`raw/run_AB.log`). Nothing was graded. **Everything below is measured on
retrieval and graph reach with no LLM in the loop**: it bounds what either channel could possibly
supply, not what the model does with it. That bound turned out to be the whole story.

### The pre-flight histogram passes, and it is not enough

§3 proposed binning entities by document frequency and abandoning the corpus if under ~20% land in
the seedable 2–19 band. Collection 35 clears it:

| entity document frequency | count | share |
| --- | --- | --- |
| 1 document → rejected as a seed | 1,626 | 73.6% |
| **2–19 → usable seed** | **565** | **25.6%** |
| 20+ → hub, seed only | 19 | 0.9% |

25.6% against collection 26's 13.6%, on a corpus purpose-built for it. Then look at *which* entities
recur — the top of the document-frequency ranking:

| rank | docs | entity |
| --- | --- | --- |
| 1 | 153 | Division of Corporation Finance |
| 2 | 117 | SEC |
| 3 | 117 | Securities and Exchange Commission |
| 4 | 94 | Form 10-K |
| 5 | 91 | Staff |
| 6 | 90 | Company |
| 7 | 86 | Commission |
| 8 | 75 | Jim B. Rosenberg |
| 9 | 63 | U.S. Securities and Exchange Commission |
| 10 | 58 | United States Securities and Exchange Commission |

The regulator's own name under six spellings, its address, its staff reviewers, and the form types.
The first entity in the ranking that a question could plausibly be *about* is a company name, at rank
21. Not one accounting topic appears in the top 50.

**The §3 criterion measures whether entities recur, not whether what recurs discriminates.** In a
single-genre corpus those come apart completely: the thing every document shares is the letterhead.
The histogram needs a second gate — strip the entities that appear in the boilerplate of every
document, then re-bin what is left.

### Only 11 of 183 questions have a seedable topic

Each question is keyed to a hub — its accounting topic, or the authority it cites. Against the
graph's gazetteer:

| | n | share |
| --- | --- | --- |
| hub is an entity in the graph at all | 94 / 183 | 51% |
| ...and its document frequency is ≥ 2, so `GRAPH_MIN_SEED_DOC_FREQ` will seed on it | **11 / 183** | **6%** |

77 of the 94 matched hubs appear in exactly one document and are rejected as seeds. `count` is the
extreme case: the graph never learned "ASC 605-25-25" or "Regulation G" as entities at all, so 1 of 6
hubs matched and 0 are seedable.

The graph therefore seeds on whatever else the question names, which is company names: **211 of the
245 seeds across all 183 questions are company-shaped** (86%), and the only non-company seeds in the
entire set are `Non-GAAP`, `Incyte`, `The Staff` and `Item 601(b)(10)`. Seeding on a company name is
seeding on the exact string BM25 already matches.

### Weighted evenly across archetypes, the graph reaches *less* than chunk retrieval

Over all 183 questions the graph looks like a clear win — it reaches a support letter on 69% against
chunk retrieval's 60%, at 44% mean recall against 32%. That comparison is an artifact of the question
mix: `compare` is 101 of 183, and `compare` is exactly where seeding on company names works.
`probe_retrieval.mjs` samples 84 questions stratified across the seven archetypes; on those same 84,
both channels measured the same way:

| archetype | n | chunk any-hit | chunk recall | graph any-hit | graph recall | graph uncapped |
| --- | --- | --- | --- | --- | --- | --- |
| `compare` | 16 | 88% | 53% | 81% | 59% | 94% |
| `conjunctive` | 13 | 23% | 12% | 15% | 8% | 15% |
| `count` | 6 | 17% | 6% | **0%** | **0%** | 0% |
| `holdout` | 8 | 100% | 23% | 88% | 19% | 100% |
| `recurring` | 14 | 43% | 20% | **7%** | **4%** | 7% |
| `set` | 16 | 50% | 16% | 56% | 28% | 100% |
| `shared` | 11 | 91% | 73% | 82% | 55% | 91% |
| **ALL** | **84** | **60%** | **30%** | **49%** | **27%** | **62%** |

**The graph's headline advantage does not survive an even archetype weighting.** It wins on `set`
and collapses on precisely the archetypes it was supposed to own — `recurring` at 7% and `count` at
0%, the two that key on an authority rather than on a company.

34 of the 84 questions had chunk retrieval reach no support letter at all. The graph reached one on
10 of them, 13 uncapped — the only place a graph can add something a retriever cannot. Experiment 04
measured what happens on that stratum: **every arm scored 0 correct.**

### `GRAPH_MAX_FACTS = 25` costs far more reach here than in experiment 03

**65 of 183 questions lose support documents purely to the cap.** Uncapping 2-hop expansion moves
graph reach from 69% to 81% over the full set, and the aggregation archetypes move most:

| archetype | recall @ cap 25 | recall uncapped | median facts found |
| --- | --- | --- | --- |
| `set` | 26% | **88%** | 1,161 |
| `holdout` | 19% | **82%** | 1,161 |
| `compare` | 63% | 78% | 147 |

The model was being shown 25 of a median 202 facts. That is a much larger cap effect than the
materials corpus showed — and §5 already measured what closing the gap buys: raising the cap 25 → 100
there moved 15 verdicts, 7 up and 8 down, for a net of one answer.

### Ranking by corroboration promotes the letterhead

`graph_retriever.js` scores facts by `specificity × corroboration`, and corroboration counts the
number of documents a triple appears in. In a corpus where every document is the same kind of letter,
that is a direct measure of how boilerplate a fact is. Across the eight highest-ranked facts in all
183 windows (1,304 facts):

| facts | share | pattern |
| --- | --- | --- |
| 311 | 24% | `<company> — also known as → Company` |
| 128 | 10% | `<company> — located at → <street address>` |
| 87 | 7% | `<company> — filed → Form 10-K` |

**61% of the window is boilerplate predicates** — `also known as`, `located at`, `filed`,
`is alias for`, `sent letter via`. The ranking function is working as designed and selecting for the
least informative facts in the graph, because in a single-genre corpus those are the facts with the
most corroboration.

### The same failure on the chunk side — and removing it changed nothing

`build_corpus.py` rendered every letter with a title line, `AMGN — SEC correspondence, 2007-10-15`.
docling made that the document title and `chunker.js` prefixes every chunk with `title — heading`, so
**92% of retrieved chunks contained the phrase "SEC correspondence"** — a phrase every question in
the benchmark also contains. `strip_titles.mjs` clears `metadata.title` in the stored docling output
and `reindex.mjs` re-chunks and re-embeds from it without reopening a PDF. It worked:

| | before | after |
| --- | --- | --- |
| retrieved chunks containing "SEC correspondence" | 92% | **9%** |
| questions reaching ≥1 support letter | 60% | 60% |
| mean support-letter recall | 32% | 30% |
| retrieved chunks containing an SEC letterhead marker | 29% | **37%** |

Reach did not move, and the letterhead share of retrieved chunks went *up*. Removing the dominant
uniform signal promoted the next one. **Boilerplate is not one bug with one fix; it is what a
single-genre corpus is mostly made of.**

### The questions themselves hurt retrieval

`probe_querylen.mjs` re-ran 71 of the non-`compare` questions three ways — the full question, a
keyword-only string, and a one-sentence rewrite:

| query form | reaches ≥1 support letter |
| --- | --- |
| the benchmark question as written | 38% |
| keywords only | **55%** |
| concise one-sentence rewrite | 49% |

A bare keyword string beats the question it was derived from by 17 points. The prose framing of an
aggregation question ("Both X and Y responded to SEC staff comments about Z. Did they take the same
position...") is mostly shared scaffolding, and it dilutes the embedding exactly the way the title
prefix did.

### What to take from this

1. **The §3 pre-flight test is necessary, not sufficient.** A corpus can clear the 2–19 band
   handsomely and still be useless, because the entities that recur are the ones every document
   shares. Bin the histogram *after* removing boilerplate entities, or the test passes on letterhead.
2. **Single-genre corpora are the adversarial case for corroboration-weighted ranking.** Both
   channels — `specificity × corroboration` on the graph, cosine similarity on chunks — converge on
   the shared scaffolding, by different mechanisms, and suppressing one just promotes the next.
3. **The graph's reach advantage was a question-mix artifact.** Weight the archetypes evenly and it
   reaches less than chunk retrieval, and it is worst on the authority-keyed questions it was built
   for.
4. **This is the fourth null, and the first one visible before a single answer is graded.** The
   ceiling was measured and it sits below the control's. The run was not worth finishing.
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
| `experiments/04-unbiased/` | the same corpus with the retrieval bias removed from the question set, `grading.v2.txt` (660 answers) |
| `experiments/05-corresp/` | the SEC correspondence corpus, its builders, its 183 questions and the three reach probes |
| `experiments/RESULTS.md` | every accuracy number in one place, with the question/answer pairs in `experiments/qa/` |
| `runs/` | scratch output from a fresh run; promoted into `experiments/` once a report cites it |

Inside `experiments/03-synthesis/`: `build_questions.mjs` emits and verifies the question set,
`show_batch.mjs` prints a question with every arm's answer side by side for grading,
`record_verdicts.mjs` checkpoints hand verdicts into `verdicts.synthesis.json`, and
`grade_synthesis.mjs` renders the report — refusing to hide an ungraded answer, which would
otherwise count as correct.

Inside `experiments/05-corresp/`: `fetch_corresp.py` and `build_corpus.py` pull the letters from
EDGAR and render them, `compose_questions.py` and `review.mjs` build and screen the question set,
`build_arms.mjs` creates the two collections, and `probe_retrieval.mjs`, `probe_graph.mjs` and
`probe_querylen.mjs` produce every number in §6 without calling a reasoning model. `strip_titles.mjs`
and `reindex.mjs` are the title-prefix fix and the re-index that avoids re-extracting the PDFs.

Corpus PDFs are deliberately not committed — this repository is public and the documents are
third-party. `retrieval_*.jsonl` is gitignored for the same reason: it embeds the full text of every
retrieved chunk.
