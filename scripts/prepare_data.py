#!/usr/bin/env python3
"""One-off dataset split for the Mini Inference Router (spec: docs/02-dataset.md §4).

Downloads the Bitext customer-support dataset, splits it per intent into kb / dev / eval, removes
paraphrase leakage across splits by normalized instruction, and writes JSONL files plus a manifest.
The outputs are committed, so reviewers never need Python or network access.

Usage:
    python scripts/prepare_data.py --out data --seed 42 --kb-per-intent 50 --dev-per-intent 10
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

DATASET = "bitext/Bitext-customer-support-llm-chatbot-training-dataset"
EXPECTED_INTENT_COUNT = 27
EVAL_PER_INTENT = 1
# Flags that make a case harder (docs/02 §2): typos, colloquial, keyword-only, offensive, abbreviations.
HARD_FLAGS = "ZQKWE"
SPLITS = ("eval", "dev", "kb")
FIELDS = ("id", "instruction", "response", "intent", "category", "flags")

REPO_ROOT = Path(__file__).resolve().parent.parent
NORMALIZE_FIXTURES = REPO_ROOT / "packages" / "shared" / "src" / "normalize.fixtures.json"

_PLACEHOLDER = re.compile(r"\{\{.*?\}\}")
_NON_ALNUM = re.compile(r"[^\w\s]|_")  # \w is Unicode-aware; underscore is treated as punctuation
_WHITESPACE = re.compile(r"\s+")

NORMALIZATION = (
    "lowercase; replace each {{...}} placeholder with a space; replace every character that is not a "
    "Unicode letter, digit or whitespace with a space; collapse whitespace; trim. "
    "Identical to normalize() in packages/shared (fixtures: packages/shared/src/normalize.fixtures.json)."
)


def normalize(text: str) -> str:
    """Must stay identical to packages/shared normalize() (docs/05 §2.2)."""
    text = text.lower()
    text = _PLACEHOLDER.sub(" ", text)
    text = _NON_ALNUM.sub(" ", text)
    return _WHITESPACE.sub(" ", text).strip()


def check_normalize_fixtures() -> None:
    fixtures = json.loads(NORMALIZE_FIXTURES.read_text(encoding="utf-8"))
    failures = [f for f in fixtures if normalize(f["input"]) != f["expected"]]
    if failures:
        lines = [f"  {f['input']!r}: got {normalize(f['input'])!r}, expected {f['expected']!r}" for f in failures]
        sys.exit("normalize() does not match shared fixtures:\n" + "\n".join(lines))


def has_hard_flag(flags: str | None) -> bool:
    return any(letter in (flags or "") for letter in HARD_FLAGS)


def load_rows() -> tuple[list[dict], str, str]:
    from datasets import __version__ as datasets_version
    from datasets import load_dataset
    from huggingface_hub import HfApi

    revision = HfApi().dataset_info(DATASET).sha
    ds = load_dataset(DATASET, split="train", revision=revision)
    rows = []
    for index, row in enumerate(ds):
        rows.append(
            {
                "id": f"bitext-{index:05d}",
                "instruction": row["instruction"],
                "response": row["response"],
                "intent": row["intent"],
                "category": row["category"],
                "flags": row["flags"],
                "_norm": normalize(row["instruction"]),
            }
        )
    return rows, revision, datasets_version


def split_rows(rows: list[dict], seed: int, quotas: dict[str, int]) -> tuple[dict[str, list[dict]], dict]:
    """Assign rows to splits in three passes (eval, then dev, then kb) across all intents.

    Passes run split by split, not intent by intent, so a row can never share a normalized instruction
    with any row already assigned to an earlier split, regardless of intent.
    """
    by_intent: dict[str, list[dict]] = {}
    for row in rows:
        by_intent.setdefault(row["intent"], []).append(row)

    rng = random.Random(seed)
    for intent in sorted(by_intent):  # sorted so the shuffle is independent of dataset order
        rng.shuffle(by_intent[intent])

    splits: dict[str, list[dict]] = {name: [] for name in SPLITS}
    taken_ids: set[str] = set()
    earlier_norms: set[str] = set()
    skipped: dict[str, int] = {name: 0 for name in SPLITS}

    for split in SPLITS:
        split_norms: set[str] = set()
        for intent in sorted(by_intent):
            candidates = [r for r in by_intent[intent] if r["id"] not in taken_ids]
            if split == "eval":
                # Prefer the first shuffled row with a hard flag, otherwise the first row (docs/02 §4).
                hard = [r for r in candidates if has_hard_flag(r["flags"])]
                candidates = hard[:1] + [r for r in candidates if r is not (hard[0] if hard else None)]
            picked = 0
            for row in candidates:
                if picked == quotas[split]:
                    break
                if row["_norm"] in earlier_norms:
                    skipped[split] += 1
                    continue
                splits[split].append(row)
                taken_ids.add(row["id"])
                split_norms.add(row["_norm"])
                picked += 1
            if picked < quotas[split]:
                sys.exit(f"intent {intent!r}: only {picked}/{quotas[split]} rows available for split {split!r}")
        earlier_norms |= split_norms

    return splits, skipped


def assert_splits(splits: dict[str, list[dict]], quotas: dict[str, int], intents: list[str]) -> None:
    for split, rows in splits.items():
        counts = Counter(r["intent"] for r in rows)
        bad = {i: counts.get(i, 0) for i in intents if counts.get(i, 0) != quotas[split]}
        assert not bad, f"split {split!r} has wrong counts per intent: {bad}"

    all_ids = [r["id"] for rows in splits.values() for r in rows]
    assert len(all_ids) == len(set(all_ids)), "a row id appears in more than one split"

    norms = {split: {r["_norm"] for r in rows} for split, rows in splits.items()}
    for i, a in enumerate(SPLITS):
        for b in SPLITS[i + 1 :]:
            overlap = norms[a] & norms[b]
            assert not overlap, f"normalized-instruction overlap between {a} and {b}: {sorted(overlap)[:5]}"


def write_jsonl(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for row in sorted(rows, key=lambda r: r["id"]):
            f.write(json.dumps({k: row[k] for k in FIELDS}, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "data")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--kb-per-intent", type=int, default=50)
    parser.add_argument("--dev-per-intent", type=int, default=10)
    args = parser.parse_args()

    check_normalize_fixtures()
    quotas = {"eval": EVAL_PER_INTENT, "dev": args.dev_per_intent, "kb": args.kb_per_intent}

    rows, revision, datasets_version = load_rows()
    intents = sorted({r["intent"] for r in rows})
    assert len(intents) == EXPECTED_INTENT_COUNT, f"expected {EXPECTED_INTENT_COUNT} intents, got {len(intents)}"

    splits, skipped = split_rows(rows, args.seed, quotas)
    assert_splits(splits, quotas, intents)

    args.out.mkdir(parents=True, exist_ok=True)
    for split, split_rows_ in splits.items():
        write_jsonl(args.out / f"{split}.jsonl", split_rows_)

    manifest = {
        "dataset": DATASET,
        "revision": revision,
        "split": "train",
        "rows_total": len(rows),
        "seed": args.seed,
        "per_intent": quotas,
        "eval_hard_flags": HARD_FLAGS,
        "eval_with_hard_flag": sum(has_hard_flag(r["flags"]) for r in splits["eval"]),
        "skipped_as_duplicate_of_earlier_split": skipped,
        "intents": intents,
        "counts": {s: dict(sorted(Counter(r["intent"] for r in splits[s]).items())) for s in SPLITS},
        "totals": {s: len(splits[s]) for s in SPLITS},
        "normalization": NORMALIZATION,
        "assignment": "per-intent shuffle (one random.Random(seed), intents in sorted order); "
        "split-by-split passes eval -> dev -> kb; rows whose normalized instruction is already in an "
        "earlier split are skipped",
        "tool_versions": {"python": sys.version.split()[0], "datasets": datasets_version},
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (args.out / "split_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"\n{DATASET} @ {revision[:12]}  rows={len(rows)}  seed={args.seed}\n")
    print(f"{'intent':<28}{'kb':>5}{'dev':>5}{'eval':>6}  eval flags")
    for intent in intents:
        eval_row = next(r for r in splits["eval"] if r["intent"] == intent)
        c = {s: manifest["counts"][s][intent] for s in SPLITS}
        print(f"{intent:<28}{c['kb']:>5}{c['dev']:>5}{c['eval']:>6}  {eval_row['flags']}")
    t = manifest["totals"]
    print(f"{'TOTAL':<28}{t['kb']:>5}{t['dev']:>5}{t['eval']:>6}")
    print(f"\neval rows with a hard flag ({HARD_FLAGS}): {manifest['eval_with_hard_flag']}/{t['eval']}")
    print(f"skipped as duplicates of an earlier split: {skipped}")
    print(f"wrote {', '.join(f'{s}.jsonl' for s in SPLITS)} and split_manifest.json to {args.out}")


if __name__ == "__main__":
    main()
