"""
build_corpus.py — render the letters that back the gold answers into uploadable PDFs.

Corpus scope is CORRESP letters that produced at least one substantive fact. Every gold answer
in this experiment is derived from those letters, so this is exactly the set a perfect system
would need and nothing more.

Two departures from the original plan, both forced by the question redesign:

  1. THE RESTATED COMMENT STAYS IN. The plan stripped it, because the plan's questions were
     verbatim SEC comments and leaving it in would have made the question a literal substring of
     the answering document. The questions are now aggregations that quote no comment, so that
     leak is gone -- and stripping would actively break things: topic tags are computed over
     comment AND response text, so a stripped corpus would no longer contain the evidence for
     some gold answers. A gold answer that cannot be derived from the indexed text is an
     ungradable question, not a hard one.

  2. NO 10-Ks. The plan added them as entity hubs. No question composed here needs one, and
     nineteen annual reports would add several thousand pages of text that no gold answer draws
     on -- diluting retrieval for every arm equally while multiplying ingest cost. The letters
     already share the hubs that matter (authorities, topics, filers). Adding 10-Ks later is a
     one-line change if a harder haystack is wanted.

Run:  .venv/Scripts/python.exe experiments/05-corresp/build_corpus.py
"""

from __future__ import annotations

import json
from pathlib import Path

from render_pdf import render

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
CORPUS = HERE / "corpus"
CORPUS.mkdir(parents=True, exist_ok=True)


def main() -> None:
    facts_path = RAW / "facts.json"
    if not facts_path.exists():
        raise SystemExit("raw/facts.json missing - run fetch_corresp.py first")
    facts = json.loads(facts_path.read_text(encoding="utf-8"))

    # Only letters that carry a substantive fact; a letter whose every response was boilerplate
    # supports no gold answer and would only be a distractor with no upside.
    wanted = sorted({f["doc_id"] for f in facts if f["substantive"]})

    written, missing, total_bytes = 0, [], 0
    for doc_id in wanted:
        src = RAW / f"{doc_id}.txt"
        if not src.exists():
            missing.append(doc_id)
            continue
        text = src.read_text(encoding="utf-8")
        ticker, _, date = doc_id.split("_")
        out = render(text, CORPUS / f"{doc_id}.pdf",
                     title=f"{ticker} — SEC correspondence, {date}")
        total_bytes += out.stat().st_size
        written += 1

    print(f"letters with substantive facts : {len(wanted)}")
    print(f"PDFs written                   : {written}")
    print(f"total size                     : {total_bytes/1e6:.1f} MB")
    if missing:
        print(f"MISSING cached text for        : {len(missing)}  {missing[:5]}")
    print(f"\ncorpus at {CORPUS}")


if __name__ == "__main__":
    main()
