"""
compose_questions.py — build aggregation questions from the fact table.

WHY THIS EXISTS

The question in experiment 05 is no longer "what did the SEC ask this company". A single staff
comment is answered inside a single letter, which makes it a one-hop retrieval task, and one-hop
is the regime where experiments 02, 03 and 04 already put the graph's contribution at ~0.

Every question here instead spans multiple source documents joined on a shared entity -- an
accounting authority, a disclosure topic, a filer, a review cycle. To answer, a system has to
find several documents that mention the same entity and combine what they say. Chunk retrieval
is structurally bad at this: the entity appears in each document, so top-k similarity returns
several near-identical chunks and the recall ceiling is whatever k allows. An entity-indexed
graph is supposed to be exactly the right tool. This is the graph's best honest case.

That is a deliberate shift, and it is worth being plain about: these questions are selected to
suit a knowledge graph. This experiment therefore does NOT measure "does the graph help on
average" -- experiments 02-04 already answered that, and the answer was no. It measures whether
there is any question shape where the graph helps at all. The control arm receives identical
questions, so if it matches the graph even here, that is close to conclusive.

GOLD ANSWERS ARE COMPUTED, NOT WRITTEN

Every expected answer is derived from the fact table by the same code that selects the question,
so it can be recomputed and audited. No model writes a gold answer. Where a gold answer needs
the company's reasoning, it quotes the real response text.

ARCHETYPES

  set        Which companies were questioned about <topic>?           (>=2 docs, no doc named)
  count      How many companies, split by whether they conceded?      (>=2 docs, no doc named)
  compare    Two named filers, same topic -- how did positions differ? (2 docs)
  conjunctive Which filer both conceded on X and defended on Y?        (>=2 docs)
  holdout    Of everyone asked about <topic>, who DEFENDED?            (many docs, small answer)
  recurring  Who was asked about <topic> in more than one year?        (many docs, small answer)
  shared     Which authority did these two filers BOTH cite?           (2 docs)

The last three exist because of a property of the corpus that only showed up after the facts
were built. The strongest hubs recur at 11-15 filers -- liquidity/MD&A, clinical disclosure,
fair value, revenue recognition. A plain "which companies" question on a 15-filer hub has a
15-part answer that no arm can complete, which reproduces the degenerate all-zero stratum from
experiment 04 and measures nothing. These three archetypes keep the large hub as the SEARCH
space while making the answer a small subset of it: to name the two companies that defended
their fair-value treatment you still have to reach all thirteen fair-value letters. Large
haystack, small gradable needle -- which is the retrieval-recall property this experiment is
actually trying to stress.

Run:  .venv/Scripts/python.exe experiments/05-corresp/compose_questions.py [--target 200]
"""

from __future__ import annotations

import argparse
import json
import random
from collections import defaultdict
from datetime import date
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_corresp import TOPICS as TOPIC_PATTERNS   # noqa: E402

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"

# Set questions with a huge answer set are unanswerable by any arm and produce the degenerate
# all-zero stratum seen in experiment 04. Keep the target set small enough that good retrieval
# could plausibly find all of it, but never smaller than 2 -- 1 would be a one-hop question.
MIN_SET, MAX_SET = 2, 6


# Authorities so widely cited that naming one is not evidence of having read anything. A "which
# authority did both cite" question answered by "Regulation S-K" can be guessed cold, which makes
# it a test of priors rather than of retrieval. Only specific provisions discriminate.
STRICT = False        # set by --strict

BASE_GENERIC = {
    "Regulation S-K", "Regulation S-X", "Rule 83", "Rule 12b-2", "Rule 405",
    *(f"Item {n}" for n in range(1, 17)),
    "Item 1A", "Item 1B", "Item 7A", "Item 9A",
}

# Added after review, applied only under --strict so the already-reviewed set stays reproducible.
# The material-contracts exhibit rule is cited in letters on every subject, so "which provision
# did both cite" answered by Item 601(b)(10) tests nothing about the topic that framed the
# question -- it accounted for 16 of the 52 shared questions. "Rule 100" is a mis-parse: the
# authority regex reads the number out of C&DI "Question 100.01" and reports a rule nobody cited.
STRICT_GENERIC = {
    "Item 601(b)(10)", "Item 601(b)(10)(ii)", "Item 601(b)(10)(ii)(B)", "Item 601",
    "Rule 100", "Rule 101", "Rule 102",
}
GENERIC_AUTHORITY = set(BASE_GENERIC)

# Text that must never appear as "the company's response". A staff comment quoted inside the
# response span, a signature block, or the standard Tandy acknowledgement all read as substance
# and are not: 13 compare questions were rejected in review for quoting one of them.
import re as _re
STAFF_VOICE = _re.compile(
    r"^(?:please\s+(?:tell|explain|revise|disclose|provide|confirm|advise)|we\s+note|"
    r"it\s+appears|tell\s+us|your\s+disclosure|you\s+(?:stated|state|disclose)|"
    r"\|?\s*\d{1,2}\.\s)", _re.IGNORECASE)
NO_SUBSTANCE = _re.compile(
    r"^(?:sincerely|very\s+truly|respectfully\s+submitted|/s/|cc:)|"
    r"is\s+responsible\s+for\s+the\s+adequacy\s+and\s+accuracy|"
    r"do\s+not\s+foreclose\s+the\s+Commission", _re.IGNORECASE)


def quotable(fact: dict, topic: str) -> bool:
    """Can this response be quoted as evidence of the company's position on `topic`?

    Three conditions, each one a defect found by reading the first pass:
      - the quoted window actually mentions the topic (15 questions quoted text about a
        different subject entirely, so the question's premise was false);
      - it does not open in the SEC's voice (13 questions attributed a staff comment to the
        company);
      - it is not a signature block or the Tandy acknowledgement (3 questions quoted those).
    """
    body = " ".join(fact["response"].split())
    pat = TOPIC_PATTERNS.get(topic)
    if pat is None:
        return False
    m = pat.search(body)
    if m is None:
        return False
    window = body[max(0, m.start() - 60):][:260].lstrip("*|.· 	")
    return not STAFF_VOICE.match(window) and not NO_SUBSTANCE.search(window[:200])


def load_facts() -> list[dict]:
    path = RAW / "facts.json"
    if not path.exists():
        raise SystemExit("raw/facts.json missing - run fetch_corresp.py first")
    facts = json.loads(path.read_text(encoding="utf-8"))
    # Substantive: the response says something gradable. Clean: it is one comment/response pair
    # rather than an unsplit slab of the letter. Both are required -- a slab puts its filer into
    # answer sets it does not belong in, and any excerpt quoted from it may be about a different
    # comment entirely.
    return [f for f in facts if f["substantive"] and f.get("clean", True)]


def position(fact: dict) -> str:
    """One-word summary of how the company answered, from the recorded flags."""
    if fact["defended"] and not fact["conceded"]:
        return "defended its existing treatment"
    if fact["conceded"] and not fact["defended"]:
        return "agreed to revise"
    if fact["conceded"] and fact["defended"]:
        return "defended its treatment while agreeing to expand disclosure"
    return "provided supplemental information"


def excerpt(fact: dict, topic: str | None = None, n: int = 260) -> str:
    """A window of the response that actually shows the topic being discussed.

    Taking the first n characters reliably returned "The Company acknowledges the Staff's
    comment and has considered the guidance in..." -- true of almost every letter and evidence
    of nothing. Where the topic's own vocabulary appears, quote from there instead.
    """
    body = " ".join(fact["response"].split())
    start = 0
    if topic and topic in TOPIC_PATTERNS:
        m = TOPIC_PATTERNS[topic].search(body)
        if m:
            start = max(0, m.start() - 60)
    piece = body[start:start + n]
    return ("..." if start else "") + piece + ("..." if start + n < len(body) else "")


def by_entity(facts: list[dict], field: str) -> dict[str, list[dict]]:
    """Group facts by each value of a multi-valued field (topics / authorities)."""
    out: dict[str, list[dict]] = defaultdict(list)
    for f in facts:
        for v in f[field]:
            out[v].append(f)
    return out


def filers_of(rows: list[dict]) -> dict[str, dict]:
    """One representative fact per company, so the answer set counts companies not comments."""
    best: dict[str, dict] = {}
    for r in rows:
        cur = best.get(r["ticker"])
        if cur is None or r["response_words"] > cur["response_words"]:
            best[r["ticker"]] = r
    return best


def compose(facts: list[dict], rng: random.Random) -> list[dict]:
    out: list[dict] = []

    def emit(kind: str, question: str, expected: str, support: list[dict], hub: str) -> None:
        docs = sorted({f["doc_id"] for f in support})
        if len(docs) < 2:          # hard floor: never emit a single-hop question
            return
        out.append({
            "id": f"Q{len(out)+1:04d}",
            "type": kind,
            "hub": hub,
            "question": question,
            "expectedAnswer": expected,
            "supportDocIds": docs,
            "supportFilers": sorted({f["ticker"] for f in support}),
            "nDocs": len(docs),
        })

    # ---------------------------------------------------------------- set / count
    for field, noun in (("topics", "topic"), ("authorities", "authority")):
        for entity, rows in by_entity(facts, field).items():
            if entity in GENERIC_AUTHORITY:
                continue      # "which companies cited Item 7" is a question about a heading
            reps = filers_of(rows)
            if not (MIN_SET <= len(reps) <= MAX_SET):
                continue
            names = sorted(r["company"] for r in reps.values())
            support = list(reps.values())

            lead = (f"responded to SEC staff comments concerning {entity}"
                    if noun == "topic" else
                    f"cited {entity} in responding to SEC staff comments")
            # Asking for the position as well as the name made the gold answer depend on the
            # concede/defend flags, and 44 of 120 facts trip neither flag and fall through to a
            # vague "provided supplemental information" that is not gradable. The membership set
            # is exactly computable, so the question asks only for that; positions are tested by
            # the count and holdout archetypes, where the flag is the point of the question.
            emit("set",
                 f"Which companies in this document set {lead}? Name every such company.",
                 "The companies are: " + ", ".join(names) + f" ({len(names)} in total).",
                 support, entity)

            # Exclusive buckets. The flags are independent, so listing "agreed" and "defended"
            # from raw flags put one company in both halves of the same gold answer -- a
            # contradiction no judge can score.
            conceded = sorted(r["company"] for r in reps.values()
                              if r["conceded"] and not r["defended"])
            defended = sorted(r["company"] for r in reps.values()
                              if r["defended"] and not r["conceded"])
            if not conceded or not defended:
                continue          # a split question needs something on both sides of the split
            emit("count",
                 f"How many distinct companies in this document set addressed {entity} "
                 f"in correspondence with the SEC staff, and how many of them agreed to "
                 f"revise their disclosure?",
                 f"{len(reps)} companies addressed {entity} ({', '.join(names)}). "
                 f"{len(conceded)} agreed to revise ({', '.join(conceded)}); "
                 f"{len(defended)} defended their existing treatment "
                 f"({', '.join(defended)}).",
                 support, entity)

    # ---------------------------------------------------------------- compare
    for entity, rows in by_entity(facts, "topics").items():
        reps = list(filers_of(rows).values())
        if len(reps) < 2:
            continue
        rng.shuffle(reps)
        rot = reps[1:] + reps[:1]
        for a, b in list(zip(reps[::2], reps[1::2])) + list(zip(rot[::2], rot[1::2])):
            if a["ticker"] == b["ticker"]:
                continue
            # A pair where neither side tripped a position flag yields "both provided
            # supplemental information" -- true, vacuous, and impossible to grade against.
            if not (a["conceded"] or a["defended"]) and not (b["conceded"] or b["defended"]):
                continue
            if STRICT and not (quotable(a, entity) and quotable(b, entity)):
                continue
            same = (a["conceded"] == b["conceded"]) and (a["defended"] == b["defended"])
            emit("compare",
                 f"Both {a['company']} and {b['company']} responded to SEC staff comments "
                 f"about {entity}. Did they take the same position, and how did their "
                 f"reasoning differ?",
                 f"{'They took the same position.' if same else 'No, their positions differed.'} "
                 f"{a['company']} {position(a)}: \"{excerpt(a, entity)}\" "
                 f"{b['company']} {position(b)}: \"{excerpt(b, entity)}\"",
                 [a, b], entity)

    # ---------------------------------------------------------------- holdout
    # Uses the big hubs that the set/count size cap excludes. The search space is every filer on
    # the topic -- 29 of them for clinical disclosure -- while the answer is only the handful who
    # pushed back. That is the large-haystack/small-needle shape this experiment wants.
    for entity, rows in by_entity(facts, "topics").items():
        reps = filers_of(rows)
        if len(reps) < 3:
            continue
        held = {t: r for t, r in reps.items() if r["defended"] and not r["conceded"]}
        if not (1 <= len(held) <= MAX_SET) or len(held) == len(reps):
            continue
        emit("holdout",
             f"Of all the companies in this document set that responded to SEC staff comments "
             f"about {entity}, which ones defended their existing treatment rather than "
             f"agreeing to revise their disclosure? Name every such company.",
             f"{len(held)} of the {len(reps)} companies questioned about {entity} defended "
             f"their treatment: "
             + ", ".join(sorted(r["company"] for r in held.values())) + ".",
             list(reps.values()), entity)

    # ---------------------------------------------------------------- recurring
    for field in ("topics", "authorities"):
        for entity, rows in by_entity(facts, field).items():
            if entity in GENERIC_AUTHORITY:
                continue
            years: dict[str, set] = defaultdict(set)
            for r in rows:
                years[r["ticker"]].add(r["filing_date"][:4])
            repeat = {t for t, ys in years.items() if len(ys) >= 2}
            if not (1 <= len(repeat) <= MAX_SET) or len(years) < 3:
                continue
            names = sorted({r["company"] for r in rows if r["ticker"] in repeat})
            emit("recurring",
                 f"Which companies in this document set were asked about {entity} by the SEC "
                 f"staff in more than one calendar year? Name them and give the years.",
                 f"{', '.join(names)}. Years: "
                 + "; ".join(f"{t}: {', '.join(sorted(years[t]))}" for t in sorted(repeat))
                 + ".",
                 [r for r in rows if r["ticker"] in repeat], entity)

    # ---------------------------------------------------------------- shared authority
    # Forces a join on two hubs at once: the topic selects the pair, the authority is the answer.
    for entity, rows in by_entity(facts, "topics").items():
        with_auth = [r for r in rows if r["authorities"]]
        seen_pairs: set = set()
        # Pair generation is quadratic and would swamp every other archetype; a benchmark that
        # is half one template measures one template. Cap the yield per topic instead.
        PER_TOPIC = 7
        for i, a in enumerate(with_auth):
            if len(seen_pairs) >= PER_TOPIC:
                break
            for b in with_auth[i + 1:]:
                if len(seen_pairs) >= PER_TOPIC:
                    break
                if a["ticker"] == b["ticker"] or a["doc_id"] == b["doc_id"]:
                    continue
                common = [x for x in a["authorities"]
                          if x in b["authorities"] and x not in GENERIC_AUTHORITY]
                key = tuple(sorted((a["ticker"], b["ticker"]))) + (entity,)
                if not common or key in seen_pairs:
                    continue
                seen_pairs.add(key)
                emit("shared",
                     f"{a['company']} and {b['company']} each responded to SEC staff comments "
                     f"touching on {entity}. Which specific accounting standard or regulatory "
                     f"provision did both of them cite in those responses?",
                     f"Both cited {', '.join(common)}.",
                     [a, b], entity)

    # ---------------------------------------------------------------- conjunctive
    per_filer: dict[str, list[dict]] = defaultdict(list)
    for f in facts:
        per_filer[f["ticker"]].append(f)
    for ticker, rows in per_filer.items():
        conceded = [r for r in rows if r["conceded"] and r["topics"]]
        defended = [r for r in rows if r["defended"] and not r["conceded"] and r["topics"]]
        if not conceded or not defended:
            continue
        pair = next((( c, d) for c in conceded for d in defended
                     if c["doc_id"] != d["doc_id"] and c["topics"][0] != d["topics"][0]), None)
        if pair is None:
            continue      # same doc collapses to one hop; same topic is self-contradictory
        c, d = pair
        emit("conjunctive",
             f"Identify the company in this document set that agreed to revise its disclosure "
             f"regarding {c['topics'][0]} but separately declined to change its treatment of "
             f"{d['topics'][0]}, defending it to the staff. Name the company and both subjects.",
             f"{c['company']}. It agreed to revise on {c['topics'][0]}, and defended its "
             f"treatment of {d['topics'][0]}.",
             [c, d], ticker)

    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=200)
    ap.add_argument("--seed", type=int, default=20260812)
    ap.add_argument("--strict", action="store_true",
                    help="apply the excerpt-quality gate and extended authority blacklist")
    ap.add_argument("--out", default="candidates.json", help="output file under raw/")
    ap.add_argument("--exclude", default="",
                    help="candidates file whose questions must not be regenerated")
    args = ap.parse_args()

    global STRICT, GENERIC_AUTHORITY
    STRICT = args.strict
    if STRICT:
        GENERIC_AUTHORITY = BASE_GENERIC | STRICT_GENERIC

    facts = load_facts()
    rng = random.Random(args.seed)
    cand = compose(facts, rng)

    if args.exclude:
        prior = json.loads((RAW / args.exclude).read_text(encoding="utf-8"))
        seen = {(q["type"], q["hub"], tuple(sorted(q["supportFilers"]))) for q in prior}
        before = len(cand)
        cand = [q for q in cand
                if (q["type"], q["hub"], tuple(sorted(q["supportFilers"]))) not in seen]
        print(f"excluded {before - len(cand)} already-reviewed questions")

    # Spread the sample across archetypes rather than letting whichever archetype happens to be
    # most productive dominate; a benchmark made of 90% "set" questions measures one skill.
    buckets: dict[str, list[dict]] = defaultdict(list)
    for q in cand:
        buckets[q["type"]].append(q)
    for v in buckets.values():
        rng.shuffle(v)

    picked: list[dict] = []
    while len(picked) < args.target and any(buckets.values()):
        for kind in sorted(buckets):
            if buckets[kind] and len(picked) < args.target:
                picked.append(buckets[kind].pop())

    for i, q in enumerate(picked, 1):
        q["id"] = f"Q{i:03d}"

    (RAW / args.out).write_text(json.dumps(picked, indent=1), encoding="utf-8")

    print(f"substantive facts : {len(facts)}")
    print(f"candidates built  : {len(cand)}")
    print(f"selected          : {len(picked)}\n")
    print("by archetype:")
    counts: dict[str, int] = defaultdict(int)
    for q in picked:
        counts[q["type"]] += 1
    for k in sorted(counts):
        print(f"  {k:<12} {counts[k]:>4}")
    if picked:
        docs = [q["nDocs"] for q in picked]
        print(f"\nsupport documents per question: min {min(docs)}  "
              f"median {sorted(docs)[len(docs)//2]}  max {max(docs)}")
    print(f"\nwrote raw/candidates.json - review before use")


if __name__ == "__main__":
    main()
