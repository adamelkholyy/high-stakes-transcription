#!/usr/bin/env python3
"""Compare WhisperX aligned words with the public-domain reference text."""

from __future__ import annotations

import argparse
import difflib
import json
import re
from pathlib import Path


WORD_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")


def normalise_words(text: str) -> list[str]:
    text = (
        text.lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("–", " ")
        .replace("—", " ")
    )
    return WORD_RE.findall(text)


def phrase_index(words: list[str], phrase: str, *, last: bool = False) -> int:
    needle = normalise_words(phrase)
    matches = [i for i in range(len(words) - len(needle) + 1) if words[i : i + len(needle)] == needle]
    if not matches:
        raise ValueError(f"Phrase not found: {phrase!r}")
    return matches[-1] if last else matches[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("aligned_json", type=Path)
    parser.add_argument("reference_txt", type=Path)
    parser.add_argument("output_json", type=Path)
    parser.add_argument("--start", default="INTRODUCTION TO JOE MULLER")
    parser.add_argument("--end", default="CHAPTER TWO THE STORY OF THE NOTEBOOK")
    args = parser.parse_args()

    aligned = json.loads(args.aligned_json.read_text(encoding="utf-8"))
    reference_text = args.reference_txt.read_text(encoding="utf-8")

    reference_all = normalise_words(reference_text)
    ref_start = phrase_index(reference_all, args.start, last=True)
    ref_end = phrase_index(reference_all, args.end, last=True)
    reference = reference_all[ref_start:ref_end]

    timed_words = aligned["wordSegments"]
    hypothesis_all: list[str] = []
    token_word_indices: list[int] = []
    for word_index, item in enumerate(timed_words):
        tokens = normalise_words(str(item.get("word", "")))
        hypothesis_all.extend(tokens)
        token_word_indices.extend([word_index] * len(tokens))
    hyp_start = phrase_index(hypothesis_all, args.start)
    hypothesis = hypothesis_all[hyp_start:]

    matcher = difflib.SequenceMatcher(None, reference, hypothesis, autojunk=False)
    differences = []
    substitutions = insertions = deletions = 0

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        ref_span = reference[i1:i2]
        hyp_span = hypothesis[j1:j2]
        if tag == "replace":
            common = min(len(ref_span), len(hyp_span))
            substitutions += common
            deletions += len(ref_span) - common
            insertions += len(hyp_span) - common
        elif tag == "delete":
            deletions += len(ref_span)
        elif tag == "insert":
            insertions += len(hyp_span)

        absolute_j1 = hyp_start + j1
        absolute_j2 = hyp_start + j2
        anchor_token = min(absolute_j1, len(token_word_indices) - 1)
        end_token = min(max(absolute_j2 - 1, anchor_token), len(token_word_indices) - 1)
        anchor_index = token_word_indices[anchor_token]
        end_index = token_word_indices[end_token]
        differences.append(
            {
                "type": tag,
                "reference": " ".join(ref_span),
                "asr": " ".join(hyp_span),
                "start": timed_words[anchor_index].get("start"),
                "end": timed_words[end_index].get("end"),
                "referenceContext": " ".join(reference[max(0, i1 - 6) : min(len(reference), i2 + 6)]),
                "asrContext": " ".join(hypothesis[max(0, j1 - 6) : min(len(hypothesis), j2 + 6)]),
            }
        )

    errors = substitutions + insertions + deletions
    report = {
        "referenceWords": len(reference),
        "asrWords": len(hypothesis),
        "substitutions": substitutions,
        "insertions": insertions,
        "deletions": deletions,
        "wordErrorRate": errors / len(reference) if reference else None,
        "differences": differences,
    }
    args.output_json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        f"reference={len(reference)} asr={len(hypothesis)} "
        f"S={substitutions} I={insertions} D={deletions} "
        f"WER={report['wordErrorRate']:.2%} diffs={len(differences)}"
    )
    for diff in differences:
        print(
            f"{diff['start']:8.3f}s {diff['type']:7s} "
            f"REF=[{diff['reference']}] ASR=[{diff['asr']}]"
        )


if __name__ == "__main__":
    main()
