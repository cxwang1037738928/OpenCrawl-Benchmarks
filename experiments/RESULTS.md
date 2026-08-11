# Results — four experiments, 860 questions, 2,540 graded answers

Every accuracy number this repo has produced, in one place. The question/answer pairs
behind them are in [`qa/`](qa/), one JSON file per experiment: question, expected answer,
what each arm replied, and how it was graded.

Grading is by hand throughout, against the expected answer. Buckets are
**Correct** / **Partially Correct** / **Wrong**. Accuracy below is Correct only.

---

## 1 — Document boost (`01-doc-boost`)

Retrieval tuning, not a graph experiment. Collection 28, "Benchmark A — embedded OCR
text", ingested with the **topaz** crawler. 220 questions, one arm.

| | Correct | Partial | Wrong | accuracy |
| --- | --- | --- | --- | --- |
| collection 28 | 163 | 25 | 32 | **74.1%** |

Half credit for partials: 175.5 / 220 = 79.8%.

---

## 2 — KG ablation (`02-kg-ablation`)

First test of whether the graph helps. Same 220 questions against three collections
that differ only in how much graph they were given.

| collection | graph | Correct | Partial | Wrong | accuracy |
| --- | --- | --- | --- | --- | --- |
| 30 | none | 163 | 26 | 31 | **74.1%** |
| 31 | whole corpus — 1,610 entities / 880 relations | 163 | 26 | 31 | **74.1%** |
| 32 | random 40% — 1,180 entities / 675 relations | 162 | 25 | 33 | **73.6%** |

**Spread: 1 answer of 220.** A full graph and no graph at all scored identically.

---

## 3 — Synthesis benchmark (`03-synthesis`)

Harder questions — cross-document and multi-hop — built from two review PDFs over a
192-document materials corpus. 200 questions, four arms.

| arm | Correct | Partial | Wrong | accuracy |
| --- | --- | --- | --- | --- |
| 26@25 — graph, 25 facts | 106 | 73 | 21 | **53.0%** |
| 26@100 — graph, 100 facts | 107 | 70 | 23 | **53.5%** |
| 26@25f1 — graph, seed floor 1 | 107 | 72 | 21 | **53.5%** |
| 33 — no graph (control) | 101 | 73 | 26 | **50.5%** |

**Spread: 6 answers of 200.** Graph beat control by 5. Quadrupling the fact cap bought
1 answer; dropping the seed floor bought 1.

The caveat that motivated experiment 4: these questions were generated *from the review
PDFs*, which carried a retrieval bias into the question set.

---

## 4 — Unbiased benchmark (`04-unbiased`)

Same corpus, questions rebuilt without that bias — sampled uniformly from document text,
never filtered on whether retrieval or the graph could answer them. Both reachabilities
measured afterward and recorded as strata. 220 questions, three arms.

| arm | Correct | Partial | Wrong | accuracy |
| --- | --- | --- | --- | --- |
| 26f2 — graph, seed floor 2 | 126 | 61 | 33 | **57.3%** |
| 26f1 — graph, seed floor 1 | 126 | 63 | 31 | **57.3%** |
| 33 — no graph (control) | 123 | 64 | 33 | **55.9%** |

**Spread: 3 answers of 220, against a measured noise floor of ~6.**

The noise floor is not an estimate. 73 questions received a byte-identical fact window in
the two graph arms — same prompt, two draws at `temperature: 0.2` with no seed — and 2 of
those 73 came back with different verdicts. That is 2.7%, about 6 answers in 220. The
graph's +3 does not clear it.

### What did predict the answer

| | 26f2 | 26f1 | control |
| --- | --- | --- | --- |
| chunk retrieval reached the support doc (140 questions) | 75.0% | 73.6% | 73.6% |
| it did not (80 questions) | 26.3% | 28.8% | 25.0% |

A 48-point swing on retrieval reach, in every arm. The graph reached the support document
on 65 of 220 (29.5%). On the 8 questions where the graph reached it and retrieval did not
— the best case the set contains — **all three arms scored 0 correct**.

Three question defects were found and recorded during grading, each graded in every arm's
favour so no arm gains: V141, V192, V207. See `04-unbiased/verdicts.v2.json`.

---

## Through-line

Three independent ablations, three nulls:

| experiment | graph effect | question count |
| --- | --- | --- |
| 02 | +0 (1-answer spread across three graph conditions) | 220 |
| 03 | +5, outside a ±2 floor — but on questions carrying a retrieval bias | 200 |
| 04 | +3, inside a measured ±6 floor | 220 |

The knobs measured null twice each: fact cap 25→100, and seed floor 2→1 (which rewrote
147 of 220 fact windows in experiment 4 and left the score identical at 79 correct on
exactly those 147).

The consistent finding across all four is that **retrieval reach, not graph presence,
determines whether an answer is right.**

---

## Files

| Path | What |
| --- | --- |
| `qa/*.json` | question, expected answer, every arm's reply, every verdict + reason |
| `01-doc-boost/grading_results.txt` | full prose report |
| `02-kg-ablation/ablation_grading.txt` | full prose report |
| `03-synthesis/synthesis_grading.txt` | full prose report |
| `04-unbiased/grading.v2.txt` | full prose report, incl. per-stratum and noise floor |
| `04-unbiased/questions.v2.json`, `evidence.v2.json`, `verdicts.v2.json` | v2 source data |
| `03-synthesis/questions.json`, `evidence.json`, `verdicts.synthesis.json` | v1 source data |

Raw run files (`*.jsonl`, `*.txt` per run) were removed after consolidation. They are in
git history if a reply ever needs re-reading in full context.
