"""Event-timeline extraction over ONE transcript (timeline build).

A LOCAL Ollama model lists the concrete EVENTS described in the recording —
things that happened or were done (actions, movements, sightings), not
opinions or procedural talk. Each event cites the line it is stated in and
carries the spoken time reference if one is given ("9:42", "last Saturday
evening"). The UI renders a clickable list: clicking an event seeks the audio
to the cited segment, so the timeline is a navigation overlay — the transcript
is never mutated and nothing is asserted without a citation.

Windowing: events are local (unlike contradictions), so consecutive
word-budget windows concatenate cleanly; results are ordered by transcript
position. Prompt style follows the triage lesson: minimal task statement,
strict-JSON output, disk-cached per window.
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

# ~The 7B sweet spot used by the outline map step.
WINDOW_WORDS = 1100

# Defensive cap so a chatty model can't flood the list.
MAX_EVENTS_PER_WINDOW = 12

_SYSTEM = "You output strict JSON only."

_USER_TEMPLATE = """Below is a numbered transcript of an audio recording; each line is
"[id] SPEAKER: text" and it may contain speech-recognition errors. List the
concrete EVENTS described — things that happened or were done (actions,
movements, sightings, communications), not opinions, questions, or procedural
talk. For each event give the id of the line where it is stated, the spoken
time reference for when it happened if one is given (e.g. "9:42", "last
Saturday evening"; "" if none), and the event itself in at most 10 words.
Keep the narrative order.
Output strict JSON only:
{{"events":[{{"id":<line id>,"time":"<spoken time or empty>","event":"<what happened>"}}]}}
If no concrete events are described output {{"events":[]}}.
TRANSCRIPT:
{numbered}"""

# Bump whenever _USER_TEMPLATE / _SYSTEM changes — the cache key hashes only
# (model, window text, version), so stale entries would survive a prompt edit.
_PROMPT_VERSION = "timeline-v1"


def _coerce_id(v: Any) -> Any:
    if isinstance(v, str) and v.lstrip("-").isdigit():
        return int(v)
    return v


def _parse_events(content: str, valid_ids: set) -> List[Dict[str, Any]]:
    """Defensive parse: tolerate stray prose, coerce string ids, drop unknown
    ids / empty events, trim strings, cap the count."""
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
    for item in data.get("events", []):
        if not isinstance(item, dict):
            continue
        sid = _coerce_id(item.get("id"))
        if sid not in valid_ids:
            continue
        event = str(item.get("event", "")).strip()[:110]
        if not event:
            continue
        out.append({"id": sid, "time": str(item.get("time", "")).strip()[:50], "event": event})
        if len(out) >= MAX_EVENTS_PER_WINDOW:
            break
    return out


def run_timeline(
    transcript: Dict[str, Any],
    *,
    pick_model: Callable[[Dict[str, Any], Optional[str]], str],
    model: str,
    ollama_url: str,
    cache_dir: Optional[Any] = None,
) -> Dict[str, Any]:
    """Event extraction over the whole transcript.

    Returns {"events": [{id, time, event}], "_model", "_windows"} in transcript
    order; `id` cites the segment each event is stated in (the UI joins it to
    the segment's start time for seeking).
    """
    segments = transcript.get("segments") or []
    if not segments:
        return {"events": [], "_model": model, "_windows": 0}

    seg_words = _segment_words(transcript, pick_model)

    cache: Optional[Path] = None
    if cache_dir is not None:
        cache = Path(cache_dir)
        cache.mkdir(parents=True, exist_ok=True)

    # Consecutive word-budget windows (always ≥1 segment each).
    windows: List[List[int]] = []
    cur: List[int] = []
    cur_words = 0
    for i, words in enumerate(seg_words):
        c = len(words)
        if cur and cur_words + c > WINDOW_WORDS:
            windows.append(cur)
            cur, cur_words = [], 0
        cur.append(i)
        cur_words += c
    if cur:
        windows.append(cur)

    events: List[Dict[str, Any]] = []
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
            found = _parse_events(content, valid_ids)
            if path is not None:
                try:
                    path.write_text(json.dumps(found))
                except Exception:
                    pass
        events.extend(found)

    # Transcript order (stable: within a segment the model's order is kept).
    id_to_idx = {seg.get("id"): i for i, seg in enumerate(segments)}
    events.sort(key=lambda e: id_to_idx.get(e["id"], len(segments)))

    return {"events": events, "_model": model, "_windows": len(windows)}
