"""
probe_edgar.py — reconnaissance before any parser gets written.

Three questions have to be answered from real filings, not from assumptions, because
every downstream decision depends on them:

  1. VOLUME    Do biotech filers actually have enough UPLOAD/CORRESP threads to reach
               400+ comment/response pairs? The plan treats filer count as the free
               variable, and this is the measurement that sets it.

  2. PAIRING   Can an UPLOAD be matched to its CORRESP by CIK plus date proximity?
               EDGAR does not link them, so this has to be verified empirically.

  3. FORMAT    Does CORRESP restate the SEC's comment verbatim before answering? The
               whole leak-control decision rests on this being true. If letters do not
               use consistent comment numbering, the deterministic parse is not viable
               and the plan needs revisiting before anything is built.

Writes nothing into the corpus. Dumps a couple of full letters to raw/ so the actual
structure can be read by eye.

Run:  .venv/Scripts/python.exe experiments/05-corresp/probe_edgar.py
Env:  SEC_IDENTITY — the SEC requires a contact email on every request and rate-limits
      by it. Defaults to the address configured for this machine.
"""

import os
import sys
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
RAW.mkdir(parents=True, exist_ok=True)

IDENTITY = os.environ.get("SEC_IDENTITY", "ericwang030@gmail.com")

try:
    from edgar import Company, set_identity
except ModuleNotFoundError:
    sys.exit("edgartools is not installed. Run:\n"
             "  .venv/Scripts/python.exe -m pip install edgartools fpdf2")

set_identity(IDENTITY)

# Biotech / pharma, deliberately weighted toward small and mid caps: the SEC comments
# far more heavily on smaller and newer filers than on large caps, and thread volume
# per filer is what decides whether 400+ pairs is reachable at ~20 filers or needs 40.
TICKERS = [
    "MRNA", "BNTX", "NVAX", "SRPT", "ALNY", "BMRN", "IONS", "NBIX", "EXEL", "HALO",
    "ARWR", "FOLD", "RARE", "ACAD", "INSM", "PTCT", "AMRN", "CRSP", "EDIT", "NTLA",
]


def summarize(ticker: str) -> dict:
    """Count UPLOAD and CORRESP filings for one filer."""
    try:
        company = Company(ticker)
    except Exception as exc:                                   # unknown ticker, network
        return {"ticker": ticker, "error": f"{type(exc).__name__}: {exc}"}

    row = {"ticker": ticker, "cik": getattr(company, "cik", None), "error": None}
    for form in ("UPLOAD", "CORRESP"):
        try:
            filings = company.get_filings(form=form)
            dates = [str(getattr(f, "filing_date", "")) for f in filings]
            row[form] = len(dates)
            row[f"{form}_dates"] = sorted(dates)[-6:]           # most recent few
        except Exception as exc:
            row[form] = 0
            row[f"{form}_dates"] = []
            row["error"] = f"{form}: {type(exc).__name__}: {exc}"
    return row


def dump_sample(ticker: str) -> None:
    """Write one CORRESP and one UPLOAD to raw/ so the format can be read by eye."""
    company = Company(ticker)
    for form in ("CORRESP", "UPLOAD"):
        filings = company.get_filings(form=form)
        if not len(filings):
            print(f"  {ticker}: no {form} to sample")
            continue
        filing = filings[0]
        try:
            body = filing.markdown()
        except Exception:
            body = filing.text()
        out = RAW / f"SAMPLE_{ticker}_{form}_{filing.filing_date}.txt"
        out.write_text(body, encoding="utf-8")
        print(f"  wrote {out.name}  ({len(body):,} chars)")


def main() -> None:
    print(f"SEC identity: {IDENTITY}\n")
    print(f"{'ticker':<8}{'CIK':<12}{'UPLOAD':>7}{'CORRESP':>9}   most recent CORRESP")
    print("-" * 78)

    rows, total_up, total_corr = [], 0, 0
    for ticker in TICKERS:
        row = summarize(ticker)
        rows.append(row)
        if row.get("error") and not row.get("CORRESP"):
            print(f"{ticker:<8}{'—':<12}{'—':>7}{'—':>9}   {row['error'][:40]}")
            continue
        total_up += row.get("UPLOAD", 0)
        total_corr += row.get("CORRESP", 0)
        recent = ", ".join(row.get("CORRESP_dates", [])[-3:]) or "none"
        print(f"{ticker:<8}{str(row.get('cik')):<12}{row.get('UPLOAD', 0):>7}"
              f"{row.get('CORRESP', 0):>9}   {recent}")

    print("-" * 78)
    print(f"{'TOTAL':<8}{'':<12}{total_up:>7}{total_corr:>9}")
    print(f"\nfilers with at least one CORRESP: "
          f"{sum(1 for r in rows if r.get('CORRESP', 0) > 0)} of {len(TICKERS)}")
    # A thread typically carries several numbered comments, so pairs >> threads.
    print(f"if each CORRESP yields ~4 numbered comments: ~{total_corr * 4} pairs")

    (RAW / "probe_summary.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    print(f"\nwrote {RAW.name}/probe_summary.json")

    sampled = next((r["ticker"] for r in rows if r.get("CORRESP", 0) > 0), None)
    if sampled:
        print(f"\nsampling letters from {sampled} so the format can be inspected:")
        dump_sample(sampled)
    else:
        print("\nNO CORRESP FOUND for any ticker — the plan needs revisiting before "
              "anything else is built.")


if __name__ == "__main__":
    main()
