"""
assay_format.py — measure whether CORRESP letters actually yield usable gold answers.

The MRNA sample exposed a risk the plan did not anticipate. Its response reads, in full:

    "The Company respectfully acknowledges the Staff's comment and will revise its
     disclosures accordingly in its future filings, as applicable."

That is a content-free acknowledgement. As a gold answer it measures nothing: every arm
scores identically against boilerplate, and a benchmark built mostly from these would be
dead on arrival regardless of what the graph does.

So this assay answers two questions across a real sample before the parser is written:

  1. PARSEABILITY  What fraction of CORRESP letters split cleanly into numbered
                   comment/response pairs?
  2. SUBSTANCE     Of those pairs, what fraction have a response with actual content --
                   figures, calculations, accounting reasoning -- rather than a promise
                   to revise later?

Substance is scored on observable features only (length, digits, currency, references to
standards), never on whether retrieval or the graph could reach it, so filtering on it
later stays neutral with respect to both channels.

Run:  .venv/Scripts/python.exe experiments/05-corresp/assay_format.py [letters_per_filer]
"""

import os
import re
import sys
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
RAW.mkdir(parents=True, exist_ok=True)

IDENTITY = os.environ.get("SEC_IDENTITY", "ericwang030@gmail.com")
PER_FILER = int(sys.argv[1]) if len(sys.argv) > 1 else 3

from edgar import Company, set_identity                                # noqa: E402

set_identity(IDENTITY)

TICKERS = ["MRNA", "BNTX", "NVAX", "SRPT", "ALNY", "BMRN", "IONS", "NBIX", "EXEL",
           "HALO", "ARWR", "RARE", "ACAD", "INSM", "PTCT", "AMRN", "CRSP", "EDIT", "NTLA"]

# edgartools' markdown escapes punctuation: "Note 4\." and "\(the \u201cCompany\u201d\)".
UNESCAPE = re.compile(r"\\([.\-()\[\]*_#$])")

# "# Response to Comment 1:", "Response to Comment 1.", "Response:" - the anchor that
# separates the restated staff comment from the company's own words.
RESPONSE_HEAD = re.compile(
    r"^\s*#*\s*(?:Company\s+)?Response(?:\s+to\s+(?:Staff\s+)?Comment)?\s*(?:No\.?\s*)?(\d+)?\s*[:.]",
    re.IGNORECASE | re.MULTILINE,
)

# A response that only promises future action carries no answer to grade.
BOILERPLATE = re.compile(
    r"will\s+revise|in\s+future\s+filings|respectfully\s+acknowledges|"
    r"acknowledges\s+the\s+staff|has\s+no\s+further|will\s+comply|noted",
    re.IGNORECASE,
)
# Signals that a response actually explains something.
CURRENCY = re.compile(r"[$€£]\s?[\d,]+|\b\d[\d,]*\.?\d*\s?(?:million|billion|thousand)\b", re.I)
STANDARD = re.compile(r"\bASC\s*\d{3}|\bASU\s*\d{4}|\bIFRS\s*\d+|\bRule\s+\d+|\bItem\s+\d+", re.I)


def clean(text: str) -> str:
    return UNESCAPE.sub(r"\1", text or "")


def split_pairs(body: str) -> list[dict]:
    """Split a CORRESP into (comment, response) pairs on the Response header."""
    heads = list(RESPONSE_HEAD.finditer(body))
    if not heads:
        return []
    pairs = []
    for i, head in enumerate(heads):
        # Comment text = everything between the previous response and this header.
        start = heads[i - 1].end() if i else 0
        comment = body[start:head.start()].strip()
        end = heads[i + 1].start() if i + 1 < len(heads) else len(body)
        response = body[head.end():end].strip()
        pairs.append({"n": head.group(1), "comment": comment, "response": response})
    return pairs


def score(response: str) -> dict:
    """Observable features only - nothing about retrieval or graph reachability."""
    words = len(response.split())
    has_money = bool(CURRENCY.search(response))
    has_std = bool(STANDARD.search(response))
    boiler = bool(BOILERPLATE.search(response))
    # Substantive = long enough to contain an argument, and carrying at least one
    # concrete anchor, and not purely a promise to revise.
    substantive = words >= 60 and (has_money or has_std or words >= 150) and not (
        boiler and words < 100)
    return {"words": words, "currency": has_money, "standard": has_std,
            "boilerplate": boiler, "substantive": substantive}


def main() -> None:
    letters = pairs_all = parseable = 0
    rows, examples = [], []

    for ticker in TICKERS:
        try:
            filings = Company(ticker).get_filings(form="CORRESP")
        except Exception as exc:
            print(f"{ticker}: {type(exc).__name__}")
            continue
        for filing in list(filings)[:PER_FILER]:
            letters += 1
            try:
                body = clean(filing.markdown())
            except Exception:
                try:
                    body = clean(filing.text())
                except Exception:
                    continue
            pairs = split_pairs(body)
            if pairs:
                parseable += 1
            for p in pairs:
                pairs_all += 1
                s = score(p["response"])
                rows.append({"ticker": ticker, "date": str(filing.filing_date), **s})
                if s["substantive"] and len(examples) < 3:
                    examples.append({"ticker": ticker, "date": str(filing.filing_date),
                                     "comment": p["comment"][-400:],
                                     "response": p["response"][:700]})
        print(f"  {ticker:<6} letters so far {letters:>3}  pairs {pairs_all:>4}", flush=True)

    sub = [r for r in rows if r["substantive"]]
    print("\n" + "=" * 70)
    print(f"letters fetched        : {letters}")
    print(f"letters that parsed    : {parseable}  ({100*parseable/max(letters,1):.0f}%)")
    print(f"comment/response pairs : {pairs_all}  ({pairs_all/max(parseable,1):.1f} per parsed letter)")
    print(f"SUBSTANTIVE pairs      : {len(sub)}  ({100*len(sub)/max(pairs_all,1):.0f}% of pairs)")
    if rows:
        med = sorted(r["words"] for r in rows)[len(rows) // 2]
        print(f"median response words  : {med}")
        print(f"  with currency figures: {100*sum(r['currency'] for r in rows)/len(rows):.0f}%")
        print(f"  citing a standard    : {100*sum(r['standard'] for r in rows)/len(rows):.0f}%")
        print(f"  boilerplate phrasing : {100*sum(r['boilerplate'] for r in rows)/len(rows):.0f}%")

    # 233 CORRESP exist across these filers; project the usable yield.
    if letters:
        print(f"\nprojected over all 233 CORRESP: "
              f"~{round(233 * pairs_all / letters)} pairs, "
              f"~{round(233 * len(sub) / letters)} substantive")

    (RAW / "assay_rows.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    (RAW / "assay_examples.json").write_text(json.dumps(examples, indent=1), encoding="utf-8")
    print(f"\nwrote raw/assay_rows.json and raw/assay_examples.json")


if __name__ == "__main__":
    main()
