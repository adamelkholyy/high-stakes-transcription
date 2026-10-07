"""Cross-sentence contradiction check over ONE transcript (anomaly build).

A LOCAL Ollama model reads the numbered transcript and flags PAIRS of lines
that appear to conflict — about a time, a place, a person's identity/role, or
what happened. It is a pointing aid, not a verdict: each flag names the two
lines and a short note, and the reviewer re-checks them against the audio.
The transcript is never mutated (overlay only), and "no conflicts" is an
explicitly allowed answer so the model is not pressured into inventing one.

Windowing: contradictions are CROSS-line, so the whole transcript goes to one
call whenever it fits a word budget (feedback-round materials always do).
Longer transcripts fall back to consecutive windows — conflicts that straddle
a window boundary are missed in this v1 (a v2 would extract claims per window
and compare them globally).

Prompt style follows the triage lesson (server/prototypes, 2026-07-06): a
minimal task statement, strict-JSON output, disk-cached per window.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# Same reuse precedent as outline.py / triage.py: import the proven plumbing.
from focus_llm import OllamaError, _segment_words  # noqa: F401
from outline import _ollama_chat_retry
from triage import _numbered_with_speaker

# Whole transcript in ONE call while it fits (cross-line visibility is the
# point); beyond that, consecutive windows of ~WINDOW_WORDS.
MAX_SINGLE_WORDS = 2400
WINDOW_WORDS = 1800

# Defensive cap so a chatty model can't flood the reviewer.
MAX_CONFLICTS_PER_WINDOW = 12

_TYPES = {"time", "place", "person", "statement"}

_SYSTEM = "You output strict JSON only."

_USER_TEMPLATE = """Below is a numbered transcript of an audio recording; each line is
"[id] SPEAKER: text" and it may contain speech-recognition errors. Find factual
inconsistencies BETWEEN lines: two DIFFERENT lines that conflict about a time,
a place, a person's identity or role, or what happened. Report only clear
conflicts a reviewer should re-check against the audio — not rephrasings,
hedges, or vague differences.
Output strict JSON only:
{{"conflicts":[{{"a":<line id>,"b":<line id>,"type":"time"|"place"|"person"|"statement","note":"<=12 words: what conflicts>"}}]}}
If there are no clear conflicts output {{"conflicts":[]}}.
TRANSCRIPT:
{numbered}"""

# Bump whenever _USER_TEMPLATE / _SYSTEM changes — the cache key hashes only
# (model, window text, version), so stale entries would survive a prompt edit.
_PROMPT_VERSION = "anomaly-v1"


def _coerce_id(v: Any) -> Any:
    # The LLM occasionally groups several lines into one conflict end
    # ("a": [12, 14]) — take the first id so the pair stays usable instead of
    # crashing the set-membership test below (unhashable list -> HTTP 500).
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    if isinstance(v, str) and v.lstrip("-").isdigit():
        return int(v)
    # Anything still unhashable (dict/…) can never be a valid id — normalise to
    # None so the `in valid_ids` check drops it safely.
    return v if isinstance(v, (str, int, float, type(None))) else None


def _parse_conflicts(content: str, valid_ids: set) -> List[Dict[str, Any]]:
    """Defensive parse (triage._parse_top discipline): tolerate stray prose,
    coerce string ids, drop unknown/self/duplicate pairs, normalise the type,
    trim notes, cap the count."""
    data: Any = None
    try:
        data = json.loads(content)
    except Exception:
        try:
            s, e = content.index("{"), content.rindex("}")
            data = json.loads(content[s : e + 1])
        except Exception:
            return []
    if not isinstance(data, dict):
        return []
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for item in data.get("conflicts", []):
        if not isinstance(item, dict):
            continue
        a = _coerce_id(item.get("a"))
        b = _coerce_id(item.get("b"))
        if a not in valid_ids or b not in valid_ids or a == b:
            continue
        key = tuple(sorted([str(a), str(b)]))
        if key in seen:
            continue
        seen.add(key)
        t = str(item.get("type", "statement")).strip().lower()
        if t not in _TYPES:
            t = "statement"
        out.append(
            {"a": a, "b": b, "type": t, "note": str(item.get("note", "")).strip()[:90]}
        )
        if len(out) >= MAX_CONFLICTS_PER_WINDOW:
            break
    return out


def _word_windows(counts: List[int], budget: int) -> List[List[int]]:
    """Consecutive index windows sized by a word budget (always ≥1 segment)."""
    windows: List[List[int]] = []
    cur: List[int] = []
    cur_words = 0
    for i, c in enumerate(counts):
        if cur and cur_words + c > budget:
            windows.append(cur)
            cur, cur_words = [], 0
        cur.append(i)
        cur_words += c
    if cur:
        windows.append(cur)
    return windows


def run_anomalies(
    transcript: Dict[str, Any],
    *,
    pick_model: Callable[[Dict[str, Any], Optional[str]], str],
    model: str,
    ollama_url: str,
    cache_dir: Optional[Any] = None,
) -> Dict[str, Any]:
    """Contradiction check over the whole transcript.

    Returns {"conflicts": [{a, b, type, note}], "_model", "_windows"} where a/b
    are segment ids (a ≠ b) and type ∈ time|place|person|statement.
    """
    segments = transcript.get("segments") or []
    if not segments:
        return {"conflicts": [], "_model": model, "_windows": 0}

    seg_words = _segment_words(transcript, pick_model)
    counts = [len(w) for w in seg_words]

    cache: Optional[Path] = None
    if cache_dir is not None:
        cache = Path(cache_dir)
        cache.mkdir(parents=True, exist_ok=True)

    if sum(counts) <= MAX_SINGLE_WORDS:
        windows = [list(range(len(segments)))]
    else:
        windows = _word_windows(counts, WINDOW_WORDS)

    conflicts: List[Dict[str, Any]] = []
    seen: set = set()
    for idxs in windows:
        w_segs = [segments[i] for i in idxs]
        w_words = [seg_words[i] for i in idxs]
        numbered = _numbered_with_speaker(w_segs, w_words)
        valid_ids = {seg.get("id") for seg in w_segs}

        path = None
        found: Optional[List[Dict[str, Any]]] = None
        if cache is not None:
            key = hashlib.sha256(
                "\x00".join([model, numbered, _PROMPT_VERSION]).encode("utf-8")
            ).hexdigest()
            path = cache / f"{key}.json"
            if path.exists():
                try:
                    found = json.loads(path.read_text())
                except Exception:
                    found = None  # corrupt entry -> recompute
        if found is None:
            content = _ollama_chat_retry(
                model, ollama_url, _SYSTEM, _USER_TEMPLATE.format(numbered=numbered)
            )
            found = _parse_conflicts(content, valid_ids)
            if path is not None:
                try:
                    path.write_text(json.dumps(found))
                except Exception:
                    pass

        for c in found:
            key = tuple(sorted([str(c["a"]), str(c["b"])]))
            if key in seen:
                continue
            seen.add(key)
            conflicts.append(c)

    return {"conflicts": conflicts, "_model": model, "_windows": len(windows)}
