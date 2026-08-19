"""
parse_diag.py — find out why 63% of CORRESP letters fail to parse.

The assay measured a 37% parse rate against a single response-header pattern
("# Response to Comment 1:"). Substance was fine (81% of pairs), so parse rate is the
only thing standing between ~155 usable pairs and the ~415 the target needs. That makes
it worth diagnosing properly rather than widening the regex by guesswork.

This fetches letters, tries a battery of candidate patterns against each, and reports
which pattern would have rescued it. Letters that no pattern matches get dumped to
raw/FAIL_*.txt so their structure can be read directly.

Run:  .venv/Scripts/python.exe experiments/05-corresp/parse_diag.py [letters_per_filer]
"""

import os
import re
import sys
from collections import Counter
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

UNESCAPE = re.compile(r"\\([.\-()\[\]*_#$])")

# Candidate anchors, narrowest first. Each is tried independently so the report shows
# which one would rescue each letter -- that tells us what to actually implement.
PATTERNS = {
    "A response-to-comment": re.compile(
        r"^\s*#*\s*(?:Company\s+)?Response(?:\s+to\s+(?:Staff\s+)?Comment)?\s*(?:No\.?\s*)?(\d+)?\s*[:.]",
        re.I | re.M),
    "B bare Response:": re.compile(r"^\s*#*\s*\**\s*Response\s*\**\s*[:.]", re.I | re.M),
    "C Answer/Reply:": re.compile(r"^\s*#*\s*\**\s*(?:Answer|Reply)\s*\**\s*[:.]", re.I | re.M),
    "D inline Response:": re.compile(r"(?<![A-Za-z])Response\s*[:.]\s", re.I),
    "E numbered comment": re.compile(r"^\s*#*\s*\**\s*(?:Comment\s*)?(\d{1,2})\s*[.)]\s+\S", re.M),
    "F italic comment": re.compile(r"^\s*\*\s*\d{1,2}\\?\.\s*\*", re.M),
    "G bold Response": re.compile(r"\*\*\s*Response[^*]{0,40}\*\*", re.I),
}


def clean(text: str) -> str:
    return UNESCAPE.sub(r"\1", text or "")


def main() -> None:
    rescued = Counter()
    total = failed = 0
    dumped = 0

    for ticker in TICKERS:
        try:
            filings = Company(ticker).get_filings(form="CORRESP")
        except Exception:
            continue
        for filing in list(filings)[:PER_FILER]:
            total += 1
            try:
                body = clean(filing.markdown())
            except Exception:
                try:
                    body = clean(filing.text())
                except Exception:
                    continue

            hits = [name for name, pat in PATTERNS.items() if pat.search(body)]
            if hits:
                for h in hits:
                    rescued[h] += 1
                # Which is the FIRST pattern that works, i.e. the minimal addition?
                rescued["*first:" + hits[0]] += 1
            else:
                failed += 1
                if dumped < 4 and len(body) > 400:
                    out = RAW / f"FAIL_{ticker}_{filing.filing_date}.txt"
                    out.write_text(body[:4000], encoding="utf-8")
                    dumped += 1
        print(f"  {ticker:<6} scanned {total:>3}  no-pattern {failed:>3}", flush=True)

    print("\n" + "=" * 66)
    print(f"letters scanned      : {total}")
    print(f"matched NO pattern   : {failed}  ({100*failed/max(total,1):.0f}%)")
    print(f"\nletters each pattern would catch (patterns overlap):")
    for name in PATTERNS:
        n = rescued[name]
        print(f"  {name:<24} {n:>3}  ({100*n/max(total,1):>3.0f}%)")
    print(f"\nfirst pattern to fire, per letter:")
    for name in PATTERNS:
        n = rescued["*first:" + name]
        if n:
            print(f"  {name:<24} {n:>3}")
    print(f"\ndumped {dumped} unmatched letters to raw/FAIL_*.txt")


if __name__ == "__main__":
    main()
