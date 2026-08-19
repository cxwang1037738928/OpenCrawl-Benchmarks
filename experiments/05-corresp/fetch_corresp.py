"""
fetch_corresp.py — build the fact table that experiment 05's questions are composed from.

Design note, because this differs from the original plan:

The plan used each SEC comment verbatim as a benchmark question. Reading real letters killed
that idea. Every comment is a pointed question about one disclosure in one filing, answered in
one letter -- "explain your basis for excluding the $325 million in convertible notes from your
contractual obligations table". That is a single-hop retrieval question, and single-hop is
exactly the regime where experiments 02, 03 and 04 already measured the graph's contribution at
approximately zero. Rebuilding it on new data would buy a fifth null result.

So the comment/response pairs are not the questions. They are the FACTS. Each parsed pair becomes
a row carrying the filer, the review cycle, the form under review, the authority cited, a topic
tag and the company's actual answer. Questions are then composed ACROSS rows -- same standard at
different filers, same filer across cycles, comment against the later 10-K -- so that answering
requires reaching two or more documents linked by a shared entity. That is the shape a knowledge
graph is supposed to be good at, and the shape chunk retrieval is worst at.

Gold answers stay non-synthetic: they are composed from real response text and from fields
computed off this table, never invented.

Three things this file does that the assay did not:

  1. FILTERS ADMINISTRATIVE LETTERS. The CORRESP form carries Rule 461 acceleration requests,
     transmittal notes and review-completion acknowledgements as well as comment responses.
     Those have no comments in them, so counting them as "parse failures" understated the real
     yield. They are excluded from the denominator instead.
  2. WIDENED PARSING. parse_diag measured each candidate anchor separately: the original pattern
     caught 37% of letters, adding inline "Response:" and bare comment numbering took it to 58%
     of all letters -- and higher once administrative letters stop counting against it.
  3. STRUCTURED EXTRACTION. Topic and authority are tagged by an explicit keyword taxonomy rather
     than by a model, so every aggregation question built on them has a verifiable gold answer
     and the tagging can be audited.

Run:  .venv/Scripts/python.exe experiments/05-corresp/fetch_corresp.py [--limit N]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
CORPUS = HERE / "corpus"
for d in (RAW, CORPUS):
    d.mkdir(parents=True, exist_ok=True)

IDENTITY = os.environ.get("SEC_IDENTITY", "ericwang030@gmail.com")

from edgar import Company, set_identity                                # noqa: E402

set_identity(IDENTITY)

TICKERS = ["MRNA", "BNTX", "NVAX", "SRPT", "ALNY", "BMRN", "IONS", "NBIX", "EXEL",
           "HALO", "ARWR", "RARE", "ACAD", "INSM", "PTCT", "AMRN", "CRSP", "EDIT", "NTLA"]

# edgartools' markdown escapes punctuation: "Note 4\." and "\(the \u201cCompany\u201d\)".
UNESCAPE = re.compile(r"\\([.\-()\[\]*_#$])")

# --------------------------------------------------------------------------------------
# Letter classification
# --------------------------------------------------------------------------------------

# A CORRESP that asks for acceleration under Rule 461, or merely transmits something, contains
# no staff comments to answer. Excluding these is not cherry-picking: it is removing documents
# that carry no question, and it is decided on the letter's own boilerplate without reference to
# whether retrieval or the graph could reach it.
ADMINISTRATIVE = re.compile(
    r"Rule\s*461|accelerat\w*\s+(?:the\s+)?effective|request\w*\s+that\s+the\s+effective\s+date|"
    r"be\s+declared\s+effective|withdraw\w*\s+the\s+(?:above|registration)",
    re.IGNORECASE,
)

# Anchors that separate the restated staff comment from the company's own words. Ordered most
# specific first; the first one that fires on a letter is the one used to split it, so a letter
# with proper headers is never split on the looser inline pattern.
RESPONSE_ANCHORS = [
    ("head", re.compile(
        r"^\s*#*\s*\**\s*(?:Company\s+)?Response(?:\s+to\s+(?:Staff\s+)?Comment)?"
        r"\s*(?:No\.?\s*)?(\d+)?\s*\**\s*[:.]", re.IGNORECASE | re.MULTILINE)),
    ("bold", re.compile(r"\*\*\s*(?:Company\s+)?Response[^*\n]{0,40}\*\*\s*[:.]?", re.IGNORECASE)),
    ("inline", re.compile(r"(?<![A-Za-z])Response\s*[:.]\s+", re.IGNORECASE)),
]

# Fallback for letters that never say "Response" -- they just number the comments and answer
# underneath. Splitting on the numbering yields (comment+response) blocks rather than a clean
# pair, so these are marked and the whole block is kept as context.
COMMENT_NUM = re.compile(r"^\s*#*\s*\**\s*(?:Comment\s*)?(\d{1,2})[.)]\s+(?=\S)", re.MULTILINE)

# Where a response STOPS. Running a response to the next "Response:" anchor swallows the staff
# comment that sits between them, which put SEC comment text into gold answers that claimed to
# quote the company. A response ends at the next numbered comment, the next form heading, or the
# signature block -- whichever comes first.
RESPONSE_END = re.compile(
    r"^\s*(?:#+\s*)?\**\s*\d{1,2}[.)]\s+\S"                    # next numbered comment
    r"|^\s*#+\s*(?:Form|Item|Note|Exhibit|Amendment|Registration)\b"   # next section heading
    r"|^\s*(?:Sincerely|Very\s+truly\s+yours|Respectfully(?:\s+submitted)?)\s*,",
    re.IGNORECASE | re.MULTILINE,
)


def trim_response(text: str) -> str:
    """Cut a response span at the first boundary that belongs to the NEXT comment."""
    m = RESPONSE_END.search(text, 40)      # 40: never cut on a marker inside the first sentence
    return (text[: m.start()] if m else text).strip()

# --------------------------------------------------------------------------------------
# Structured extraction
# --------------------------------------------------------------------------------------

# Authorities are the strongest cross-document hub in this corpus: ASC 606 links a Moderna letter
# to an Alnylam letter with nothing else in common. Captured verbatim so they group exactly.
AUTHORITY = re.compile(
    r"\bASC\s*(\d{3}(?:-\d{2})*)|\bASU\s*(\d{4}-\d{2})|\bIFRS\s*(\d+)|\bIAS\s*(\d+)|"
    r"\bItem\s*(\d+\w*(?:\([a-z]\)(?:\(\d+\))?)?)|\bRule\s*(\d+[\w-]*)|"
    r"\bC&DI\s*(\d+\.\d+(?:\([a-z]\))?)|\bRegulation\s+([SG]-[KX])",
    re.IGNORECASE,
)

# Which filing the staff was reviewing. Lets "comment -> later 10-K" questions be constructed.
FORM_UNDER_REVIEW = re.compile(
    r"\bForm\s+(10-K|10-Q|8-K|S-1|S-3|S-4|F-1|F-3|F-4|20-F|DEF\s*14A)\b", re.IGNORECASE)

# The comment letter this CORRESP answers. The probe showed letters name it explicitly
# ("your letter dated April 20, 2023"), which pairs far more reliably than date proximity.
LETTER_DATED = re.compile(
    r"letter\s+dated\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})", re.IGNORECASE)

# Topic taxonomy. Keyword-tagged rather than model-tagged so that every aggregation question
# built on a topic has a gold answer that can be recomputed and audited.
TOPICS: dict[str, re.Pattern] = {
    "revenue recognition": re.compile(
        r"revenue\s+recogni|ASC\s*606|performance\s+obligation|transaction\s+price|"
        r"collaboration\s+revenue|milestone\s+payment|variable\s+consideration", re.I),
    "research and development expense": re.compile(
        r"research\s+and\s+development\s+expense|R&D\s+expense|ASC\s*730|"
        r"capitaliz\w+\s+(?:of\s+)?development|project-by-project", re.I),
    "non-GAAP measures": re.compile(
        r"non-GAAP|C&DI\s*102|equal\s+or\s+greater\s+prominence|adjusted\s+EBITDA", re.I),
    "segment reporting": re.compile(
        r"segment\s+(?:report|disclos|inform)|ASC\s*280|chief\s+operating\s+decision", re.I),
    "going concern": re.compile(
        r"going\s+concern|substantial\s+doubt|ASU\s*2014-15", re.I),
    "business combinations and IPR&D": re.compile(
        r"business\s+combination|ASC\s*805|in-process\s+research|IPR&D|purchase\s+price\s+alloc", re.I),
    "stock-based compensation": re.compile(
        r"stock-based\s+compensation|share-based\s+(?:payment|compensation)|ASC\s*718", re.I),
    "income taxes": re.compile(
        r"valuation\s+allowance|deferred\s+tax|ASC\s*740|income\s+tax\s+(?:provision|benefit)", re.I),
    "inventory": re.compile(r"\binventor(?:y|ies)\b|ASC\s*330|pre-launch", re.I),
    "impairment": re.compile(r"impair\w+|ASC\s*35[02]|ASC\s*360|goodwill", re.I),
    "contingencies and litigation": re.compile(
        r"loss\s+conting|ASC\s*450|reasonably\s+possible|legal\s+proceeding", re.I),
    "leases": re.compile(r"\bleas(?:e|es|ing)\b|ASC\s*842|right-of-use", re.I),
    "fair value": re.compile(r"fair\s+value|ASC\s*820|Level\s+3\s+input", re.I),
    "warrants and equity classification": re.compile(
        r"\bwarrant|ASC\s*815|ASC\s*480|temporary\s+equity|redeemable\s+convertible", re.I),
    "liquidity and MD&A": re.compile(
        r"liquidity|Item\s*303|contractual\s+obligation|capital\s+resources|"
        r"results\s+of\s+operations", re.I),
    "internal control": re.compile(
        r"internal\s+control|ICFR|material\s+weakness|disclosure\s+controls", re.I),
    "clinical and pipeline disclosure": re.compile(
        r"clinical\s+trial|Phase\s+[123I]|primary\s+endpoint|BLA|NDA\b|"
        r"pipeline|product\s+candidate", re.I),
    "executive compensation": re.compile(
        r"executive\s+compensation|Item\s*402|compensation\s+discussion|named\s+executive", re.I),
    "risk factors": re.compile(r"risk\s+factor|Item\s*105|Item\s*1A", re.I),
}

# How the company answered. Recorded as independent flags rather than one label because letters
# routinely concede one point and defend another in the same paragraph.
# Concessions appear in the passive as often as the active -- "the Company will revise" but also
# "substantive milestones will be included". Missing the passive form mislabelled a concession as
# a defence, because the same sentence also said "concluded that".
CONCEDED = re.compile(
    r"will\s+(?:revise|include|comply|expand|disclose|present|add|clarify|supplement)|"
    r"will\s+be\s+(?:includ|revis|expand|disclos|present|add|reclassif)\w*|"
    r"in\s+future\s+filings|ha(?:s|ve)\s+(?:been\s+)?revised|has\s+reassessed|agrees?\s+to",
    re.I)
# "concluded that" and "determined that" were dropped: they introduce a defence and a concession
# with equal frequency ("determined that neither agreement is material" vs "concluded that
# milestones will be included"), so they contributed noise rather than signal. What remains is
# phrasing that only appears when a company is declining to change something.
DEFENDED = re.compile(
    r"respectfully\s+submits|does\s+not\s+believe|do\s+not\s+believe|"
    r"believes?\s+(?:that\s+)?(?:its|the|our)\s+(?:current|existing|prior|previous|historical)|"
    r"is\s+not\s+(?:material|required)|not\s+required\s+to\s+be\s+(?:filed|disclosed)|"
    r"is\s+appropriate|remains?\s+appropriate|no\s+(?:revision|change|amendment)\s+is|"
    r"respectfully\s+(?:declines|disagrees)|continues?\s+to\s+believe", re.I)
SUPPLEMENTAL = re.compile(
    r"supplementall?y\s+(?:advise|inform|provide)|advises?\s+the\s+Staff|"
    r"provided?\s+below|set\s+forth\s+below", re.I)

CURRENCY = re.compile(r"[$€£]\s?[\d,]+|\b\d[\d,]*\.?\d*\s?(?:million|billion|thousand)\b", re.I)
BOILERPLATE_ONLY = re.compile(
    r"will\s+revise|in\s+future\s+filings|respectfully\s+acknowledges|acknowledges\s+the\s+staff", re.I)


def clean(text: str) -> str:
    return UNESCAPE.sub(r"\1", text or "")


def authorities(text: str) -> list[str]:
    """Normalised authority citations, e.g. ['ASC 606', 'Item 303(a)(5)']."""
    labels = ["ASC", "ASU", "IFRS", "IAS", "Item", "Rule", "C&DI", "Regulation"]
    out = []
    for m in AUTHORITY.finditer(text):
        for i, g in enumerate(m.groups()):
            if g:
                out.append(f"{labels[i]} {g.strip()}")
                break
    # Preserve order, drop duplicates.
    return list(dict.fromkeys(out))


def topics(text: str) -> list[str]:
    """Topics supported by more than a passing mention.

    A single hit is usually a section heading the letter is merely citing -- "Risk Factors,
    page 12", "Item 7. Management's Discussion" -- not a subject the company actually addressed.
    Tagging on those put filers into answer sets they did not belong in and produced questions
    whose premise ("both responded to comments touching on risk factors") was simply false.
    Requiring two hits keeps genuine discussion: the Insmed letter that reads as non-GAAP
    boilerplate for its first 240 characters says "milestone payment" six times further down,
    and is correctly tagged revenue recognition.
    """
    return [name for name, pat in TOPICS.items() if len(pat.findall(text)) >= 2]


def split_pairs(body: str) -> tuple[list[dict], str]:
    """Split a letter into (comment, response) pairs. Returns (pairs, anchor_name_used)."""
    for name, pat in RESPONSE_ANCHORS:
        heads = list(pat.finditer(body))
        if len(heads) >= 1:
            pairs = []
            for i, head in enumerate(heads):
                start = heads[i - 1].end() if i else 0
                comment = body[start:head.start()].strip()
                end = heads[i + 1].start() if i + 1 < len(heads) else len(body)
                response = trim_response(body[head.end():end])
                if len(response.split()) >= 25:
                    pairs.append({"comment": comment, "response": response,
                                  "n": (head.group(1) if head.groups() else None)})
            if pairs:
                return pairs, name

    # No "Response" anchor anywhere: fall back to comment numbering and keep whole blocks.
    marks = list(COMMENT_NUM.finditer(body))
    if len(marks) >= 2:
        blocks = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(body)
            block = body[m.end():end].strip()
            if len(block.split()) >= 60:
                blocks.append({"comment": block[:600], "response": block, "n": m.group(1)})
        if blocks:
            return blocks, "numbered"
    return [], "none"


def substantive(response: str, has_money: bool, auths: list[str]) -> bool:
    """Observable features only -- nothing about retrieval or graph reachability."""
    words = len(response.split())
    if words < 60:
        return False
    if BOILERPLATE_ONLY.search(response) and words < 100:
        return False
    return has_money or bool(auths) or words >= 150


# A response that still opens in the staff's voice was mis-split: the anchor landed inside the
# comment rather than after it. Two survive the boundary fix; they are excluded rather than
# quoted as if they were the company's words.
STAFF_VOICE = re.compile(
    r"^(?:please\s+(?:tell|explain|revise|disclose|provide|confirm)|we\s+note|it\s+appears|"
    r"tell\s+us)", re.IGNORECASE)


def is_clean(response: str, topic_list: list[str]) -> bool:
    """Is this one comment/response pair, or an unsplit slab of the whole letter?

    Letters that answer every comment under a single "Response:" heading produce one 1,600-word
    fact tagged with five unrelated topics. Structurally it looks like a fact; used as one it is
    poison -- it puts its filer into five different answer sets, and any excerpt quoted from it
    is about whichever comment happened to come first. The giveaway is breadth: a real single
    response covers one or two subjects, so topic count separates pairs from slabs far better
    than length alone.
    """
    if len(topic_list) > 3 or len(response.split()) > 1200:
        return False
    return not STAFF_VOICE.match(response.lstrip("*|· \t\n"))


def rebuild_from_cache() -> None:
    """Re-parse the letters already on disk, without touching EDGAR.

    Parsing rules get corrected as bad gold answers surface in review, and each correction would
    otherwise mean another rate-limited crawl of 233 filings. The letter text never changes, so
    it is cached on first fetch and re-parsed from there. Company identity is recovered from the
    previous facts.json rather than re-queried.
    """
    prior = json.loads((RAW / "facts.json").read_text(encoding="utf-8"))
    ident = {f["ticker"]: (f["company"], f["cik"]) for f in prior}

    facts: list[dict] = []
    anchor_used: Counter = Counter()
    for src in sorted(RAW.glob("*_CORRESP_*.txt")):
        doc_id = src.stem
        ticker = doc_id.split("_")[0]
        if ticker not in ident:
            continue
        company, cik = ident[ticker]
        body = src.read_text(encoding="utf-8")
        pairs, anchor = split_pairs(body)
        if not pairs:
            continue
        anchor_used[anchor] += 1
        answered = LETTER_DATED.search(body)
        forms = list(dict.fromkeys(
            m.group(1).upper().replace("  ", " ") for m in FORM_UNDER_REVIEW.finditer(body)))
        for j, p in enumerate(pairs):
            scope = p["comment"] + "\n" + p["response"]
            auths = authorities(scope)
            money = bool(CURRENCY.search(p["response"]))
            facts.append({
                "fact_id": f"{doc_id}#{j}",
                "ticker": ticker, "company": company, "cik": cik,
                "filing_date": doc_id.split("_")[2],
                "doc_id": doc_id,
                "comment_number": p["n"],
                "answers_letter_dated": answered.group(1) if answered else None,
                "forms_under_review": forms,
                "authorities": auths,
                "topics": topics(scope),
                "conceded": bool(CONCEDED.search(p["response"])),
                "defended": bool(DEFENDED.search(p["response"])),
                "supplemental": bool(SUPPLEMENTAL.search(p["response"])),
                "has_currency": money,
                "response_words": len(p["response"].split()),
                "anchor": anchor,
                "substantive": substantive(p["response"], money, auths),
                "clean": is_clean(p["response"], topics(scope)),
                "comment": p["comment"][-1200:],
                "response": p["response"][:4000],
            })

    (RAW / "facts.json").write_text(json.dumps(facts, indent=1), encoding="utf-8")
    sub = [f for f in facts if f["substantive"]]
    words = sorted(f["response_words"] for f in facts)
    print(f"re-parsed from cache: {len(list(RAW.glob('*_CORRESP_*.txt')))} letters")
    print(f"facts       : {len(facts)}  (was {len(prior)})")
    print(f"substantive : {len(sub)}")
    print(f"response words: median {words[len(words)//2] if words else 0}  "
          f"max {words[-1] if words else 0}")
    print(f"anchors: {dict(anchor_used)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="max CORRESP per filer (0 = all)")
    ap.add_argument("--from-cache", action="store_true",
                    help="re-parse cached letters instead of refetching from EDGAR")
    ap.add_argument("--tickers", default="", help="comma-separated override of the filer list")
    ap.add_argument("--merge", action="store_true",
                    help="merge into the existing facts.json instead of replacing it")
    args = ap.parse_args()

    if args.from_cache:
        rebuild_from_cache()
        return

    global TICKERS
    if args.tickers:
        TICKERS = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]

    facts: list[dict] = []
    letters = admin = responsive = parsed = 0
    anchor_used: Counter = Counter()

    for ticker in TICKERS:
        try:
            company = Company(ticker)
            filings = list(company.get_filings(form="CORRESP"))
        except Exception as exc:
            print(f"  {ticker:<6} SKIP  {type(exc).__name__}", flush=True)
            continue
        if args.limit:
            filings = filings[: args.limit]

        kept_here = 0
        for filing in filings:
            letters += 1
            try:
                body = clean(filing.markdown())
            except Exception:
                try:
                    body = clean(filing.text())
                except Exception:
                    continue
            if not body or len(body.split()) < 120:
                continue

            # Administrative letters carry no staff comments; they are not parse failures.
            head = body[:3000]
            if ADMINISTRATIVE.search(head) and not re.search(r"Response\s*[:.]", body, re.I):
                admin += 1
                continue
            responsive += 1

            pairs, anchor = split_pairs(body)
            if not pairs:
                continue
            parsed += 1
            anchor_used[anchor] += 1

            doc_id = f"{ticker}_CORRESP_{filing.filing_date}"
            (RAW / f"{doc_id}.txt").write_text(body, encoding="utf-8")
            answered = LETTER_DATED.search(body)
            forms = list(dict.fromkeys(
                m.group(1).upper().replace("  ", " ") for m in FORM_UNDER_REVIEW.finditer(body)))

            for j, p in enumerate(pairs):
                scope = p["comment"] + "\n" + p["response"]
                auths = authorities(scope)
                money = bool(CURRENCY.search(p["response"]))
                facts.append({
                    "fact_id": f"{doc_id}#{j}",
                    "ticker": ticker,
                    "company": company.name,
                    "cik": int(company.cik),
                    "filing_date": str(filing.filing_date),
                    "doc_id": doc_id,
                    "comment_number": p["n"],
                    "answers_letter_dated": answered.group(1) if answered else None,
                    "forms_under_review": forms,
                    "authorities": auths,
                    "topics": topics(scope),
                    "conceded": bool(CONCEDED.search(p["response"])),
                    "defended": bool(DEFENDED.search(p["response"])),
                    "supplemental": bool(SUPPLEMENTAL.search(p["response"])),
                    "has_currency": money,
                    "response_words": len(p["response"].split()),
                    "anchor": anchor,
                    "substantive": substantive(p["response"], money, auths),
                "clean": is_clean(p["response"], topics(scope)),
                    "comment": p["comment"][-1200:],
                    "response": p["response"][:4000],
                })
                kept_here += 1
        print(f"  {ticker:<6} letters {len(filings):>3}  facts {kept_here:>4}"
              f"   running total {len(facts)}", flush=True)

    if args.merge and (RAW / "facts.json").exists():
        prior = json.loads((RAW / "facts.json").read_text(encoding="utf-8"))
        seen = {f["fact_id"] for f in facts}
        facts = [p for p in prior if p["fact_id"] not in seen] + facts
        print(f"\nmerged with {len(prior)} prior facts")
    (RAW / "facts.json").write_text(json.dumps(facts, indent=1), encoding="utf-8")

    sub = [f for f in facts if f["substantive"]]
    print("\n" + "=" * 74)
    print(f"CORRESP fetched          : {letters}")
    print(f"  administrative (no Qs) : {admin}")
    print(f"  responsive             : {responsive}")
    print(f"  of those, parsed       : {parsed}  ({100*parsed/max(responsive,1):.0f}% of responsive)")
    print(f"facts extracted          : {len(facts)}")
    print(f"  substantive            : {len(sub)}  ({100*len(sub)/max(len(facts),1):.0f}%)")
    print(f"\nsplit anchor used: {dict(anchor_used)}")

    # The aggregation questions live or die on how well entities RECUR across filers. A standard
    # cited by one filer is a dead end; one cited by five is a hub with five documents hanging
    # off it. Report that now, before any question is written.
    print("\nrecurrence of hubs (the raw material for cross-document questions):")
    for field, label in (("authorities", "authority"), ("topics", "topic")):
        counts: dict[str, set] = {}
        for f in sub:
            for v in f[field]:
                counts.setdefault(v, set()).add(f["ticker"])
        multi = {k: v for k, v in counts.items() if len(v) >= 2}
        print(f"  {label:<10} distinct {len(counts):>4}   spanning >=2 filers: {len(multi)}")
        for k, v in sorted(multi.items(), key=lambda kv: -len(kv[1]))[:10]:
            print(f"      {k:<38} {len(v)} filers")

    print(f"\nwrote raw/facts.json  ({len(facts)} rows)")


if __name__ == "__main__":
    main()
