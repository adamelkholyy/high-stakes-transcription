"""Sentence-importance triage over ONE transcript (sentence-build variant).

A LOCAL Ollama model picks, per paragraph window, the sentences where a
transcription error would most badly mislead an investigation — the reviewer's
"check these first" set. Binary output (high/low) by design: this interface
version only needs a rough important/not-important split (ranking quality is a
separate, later workstream), so no fwd/rev fusion, no role remapping, no tiers.

Windowing reuses the outline chaptering ("the paragraph tool"): long
transcripts are split into the outline's chapters and each chapter is triaged
independently; short ones go through in one window. An outline failure degrades
to fixed-size windows — windowing is never the reason a request 500s.

The prompt is the MINIMAL selection prompt validated in
server/prototypes/triage_proto_genres.py (2026-07-06): a bare task statement
beat every hand-tuned rubric variant across models; scaffolding clauses are
only allowed back in against formally-measured failures.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# Same reuse precedent as outline.py / chat.py: import the proven plumbing.
from focus_llm import OllamaError, _segment_words  # noqa: F401
from outline import MAX_WINDOW, _ollama_chat_retry
import outline as outline_mod

# Above this many segments, window by outline chapters (below it, one call
# covers the whole transcript comfortably).
SINGLE_WINDOW_MAX = 40

_SYSTEM = "You output strict JSON only."

_USER_TEMPLATE = """Below is a numbered transcript of an audio recording; it may contain
speech-recognition errors. A reviewer has time to re-listen to only {k} lines
against the audio. Pick the {k} lines where a transcription error would most
badly mislead an investigation or a court. Order them most-critical first.
For each, give the line's id and a short reason (at most 8 words) saying why
that line is critical.
Output strict JSON only: {{"top":[{{"id":<n>,"reason":"<why critical>"}}]}} with exactly {k} items.
TRANSCRIPT:
{numbered}"""

# Bump whenever _USER_TEMPLATE / _SYSTEM changes — the cache key hashes only
# (model, window text, k), so stale entries would otherwise survive a prompt edit.
_PROMPT_VERSION = "triage-v2"


def _numbered_with_speaker(segments: List[Dict[str, Any]], seg_words) -> str:
    """`[id] SPEAKER: text` per line. Speaker labels carry real signal on real
    materials (Officer/Witness scripts); a generic/absent label degrades to the
    bare `[id] text` form the prompt was validated with."""
    lines = []
    for seg, words in zip(segments, seg_words):
        text = " ".join(w.get("text", "") for w in words).strip()
        speaker = str(seg.get("speaker") or "").strip()
        prefix = f"{speaker.upper()}: " if speaker and speaker.lower() != "speaker" else ""
        lines.append(f"[{seg.get('id')}] {prefix}{text}")
    return "\n".join(lines)


def _k_for(window_len: int) -> int:
    """~25% of a window is "important", clamped so tiny windows still pick one
    and huge ones don't flood the reviewer."""
    return max(1, min(5, round(0.25 * window_len)))


def _parse_top(content: str, valid_ids: set) -> List[Dict[str, Any]]:
    """Defensive parse (focus_llm._parse_matches discipline): tolerate stray
    prose, coerce string ids, drop unknown/duplicate ids, trim reasons."""
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
    for item in data.get("top", []):
        if not isinstance(item, dict):
            continue
        sid = item.get("id")
        if isinstance(sid, str) and sid.lstrip("-").isdigit():
            sid = int(sid)
        if sid not in valid_ids or sid in seen:
            continue
        seen.add(sid)
        out.append({"id": sid, "reason": str(item.get("reason", "")).strip()[:60]})
    return out


def _window_ranges(
    transcript: Dict[str, Any],
    segments: List[Dict[str, Any]],
    pick_model,
    model: str,
    ollama_url: str,
    cache_dir: Optional[Any],
) -> List[List[int]]:
    """Index ranges (into `segments`) to triage independently. Chapters from the
    outline when the transcript is long; fixed windows if the outline fails."""
    n = len(segments)
    if n <= SINGLE_WINDOW_MAX:
        return [list(range(n))]
    id_to_idx = {seg.get("id"): i for i, seg in enumerate(segments)}
    try:
        outline = outline_mod.run_outline(
            transcript,
            pick_model=pick_model,
            model=model,
            ollama_url=ollama_url,
            cache_dir=cache_dir,
        )
        ranges: List[List[int]] = []
        for part in outline.get("parts", []):
            for ch in part.get("chapters", []):
                a = id_to_idx.get(ch.get("start_id"))
                b = id_to_idx.get(ch.get("end_id"))
                if a is None or b is None or a > b:
                    continue
                ranges.append(list(range(a, b + 1)))
        # A gap-free chapter set covers everything; anything missed (defensive)
        # falls through to the fixed-window fallback below.
        if ranges and sum(len(r) for r in ranges) >= n * 0.9:
            return ranges
    except OllamaError:
        pass  # outline unavailable -> fixed windows; triage itself still runs
    return [list(range(s, min(s + MAX_WINDOW, n))) for s in range(0, n, MAX_WINDOW)]


def run_triage(
    transcript: Dict[str, Any],
    *,
    pick_model: Callable[[Dict[str, Any], Optional[str]], str],
    model: str,
    ollama_url: str,
    cache_dir: Optional[Any] = None,
) -> Dict[str, Any]:
    """Binary sentence-importance triage over the whole transcript.

    Returns {"segments": [{id, importance: "high"|"low", rank?, reason?}]
    (one entry per transcript segment, transcript order), "_model", "_windows"}.
    """
    segments = transcript.get("segments") or []
    if not segments:
        return {"segments": [], "_model": model, "_windows": 0}

    seg_words = _segment_words(transcript, pick_model)

    cache: Optional[Path] = None
    if cache_dir is not None:
        cache = Path(cache_dir)
        cache.mkdir(parents=True, exist_ok=True)

    windows = _window_ranges(transcript, segments, pick_model, model, ollama_url, cache)

    picked: Dict[Any, Dict[str, Any]] = {}  # id -> {rank, reason}
    rank = 0
    for idxs in windows:
        w_segs = [segments[i] for i in idxs]
        w_words = [seg_words[i] for i in idxs]
        numbered = _numbered_with_speaker(w_segs, w_words)
        k = _k_for(len(idxs))
        valid_ids = {seg.get("id") for seg in w_segs}

        path = None
        top: Optional[List[Dict[str, Any]]] = None
        if cache is not None:
            key = hashlib.sha256(
                "\x00".join([model, numbered, str(k), _PROMPT_VERSION]).encode("utf-8")
            ).hexdigest()
            path = cache / f"{key}.json"
            if path.exists():
                try:
                    top = json.loads(path.read_text())
                except Exception:
                    top = None  # corrupt entry -> recompute
        if top is None:
            content = _ollama_chat_retry(
                model, ollama_url, _SYSTEM, _USER_TEMPLATE.format(k=k, numbered=numbered)
            )
            top = _parse_top(content, valid_ids)
            if path is not None:
                try:
                    path.write_text(json.dumps(top))
                except Exception:
                    pass

        for item in top:
            if item["id"] not in picked:
                rank += 1
                picked[item["id"]] = {"rank": rank, "reason": item["reason"]}

    out = []
    for seg in segments:
        sid = seg.get("id")
        hit = picked.get(sid)
        if hit:
            out.append(
                {"id": sid, "importance": "high", "rank": hit["rank"], "reason": hit["reason"]}
            )
        else:
            out.append({"id": sid, "importance": "low"})
    return {"segments": out, "_model": model, "_windows": len(windows)}
