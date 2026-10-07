"""
outline.py
Long-transcript outline (the centre "Outline" sub-page in the reviewer UI).

A police interview can be hours long — tens of thousands of words a reviewer
cannot skim linearly. This builds a navigable, two-level "table of contents":

  Summary  — a 3–6 sentence overview of the whole recording.
  Parts    — a handful of coarse top-level sections (major phases), each with a
             2–3 sentence description and a [start,end] time range.
  Chapters — finer topical chapters nested inside each Part (short gist each).

so the reviewer can grasp what happens across the whole recording, then drill in
and jump straight to the part that matters. The transcript itself is never
mutated — the outline is a navigation overlay (clicking a part/chapter seeks).

The local LLM (via Ollama) DECIDES the chapter boundaries and names them, then a
second "synthesis" pass groups chapters into Parts and writes the descriptions +
summary. Because recordings range from ~10 minutes to ~3 hours, the chunking is
DYNAMIC:

  * the MAP window (segments per LLM call) is sized by a word budget, so each
    call is well-fed regardless of how chatty the segments are;
  * the number of Parts is duration-adaptive (a 3-hour recording gets coarser
    top-level sections, not 100 tiny ones), so the collapsed view stays
    skimmable.

A 3h transcript will not fit one context window, so the map step is map-reduce.
Reproducibility comes from temperature 0 + a fixed seed AND a per-window /
per-synthesis on-disk cache (same scheme as focus_llm.py): running again on the
same transcript is instant, and committing the cache freezes the outline.

It trains nothing and nothing leaves the machine (local Ollama). It reuses the
exact Ollama plumbing in focus_llm.py (_numbered_transcript / _ollama_chat /
_segment_words / OllamaError) rather than duplicating it.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# Reuse the deterministic Ollama plumbing rather than duplicating it.
from focus_llm import (
    OllamaError,
    _numbered_transcript,
    _ollama_chat,
    _segment_words,
)

# ----- Dynamic MAP window (segments per LLM call), sized by a word budget. -----
# A 7B model segments a ~1,000-word window cleanly but, given a much larger one,
# lumps the early part into one coarse chapter and over-attends to the tail. We
# therefore target a fixed *word* budget and clamp the resulting segment count,
# so chatty (few long segments) and terse (many short segments) transcripts both
# land in the model's sweet spot.
TARGET_MAP_WORDS = 1100
MIN_WINDOW = 8
MAX_WINDOW = 18

# Duration-adaptive number of top-level Parts. ~1.2*sqrt(minutes), clamped:
# 10min -> 4, 30min -> ~7, 1h -> ~9, 3h -> 12 (clamped). Keeps the collapsed
# outline to a scannable handful regardless of length.
MIN_PARTS = 4
MAX_PARTS = 12


_MAP_SYSTEM = (
    "You segment a police-interview transcript into a navigable chapter "
    "outline. Given a numbered passage, group CONSECUTIVE segments into topical "
    "chapters so a reviewer can skim what happens and jump to the part they "
    "need. A chapter is a stretch on one topic/phase (e.g. caution & rights, "
    "the night in question, the weapon, an alibi). Output strict JSON only."
)


def _map_user_prompt(numbered: str) -> str:
    return (
        f"PASSAGE (each line is '[id] text'):\n{numbered}\n\n"
        'Return JSON exactly: {"chapters":[{"start_id":<first segment id>,'
        '"end_id":<last segment id>,"title":"<=8 words","gist":"<=35 words, '
        'what is discussed>"}]}. Cover every segment in order, chapters must '
        "not overlap, and use the real ids shown above."
    )


# --- OLD synthesis system prompt (kept for easy revert: comment out the active
#     block below and un-comment this one) ---
# _SYNTH_SYSTEM = (
#     "You organise a police-interview chapter list into a high-level outline for "
#     "a reviewer. Group CONSECUTIVE fine-grained chapters into a few coarse PARTS "
#     "(the major phases of the interview) and write a short overall summary. "
#     "Output strict JSON only."
# )
_SYNTH_SYSTEM = (
    "You organise a police-interview chapter list into a high-level outline for "
    "a reviewer who must grasp THIS specific case quickly. Group CONSECUTIVE "
    "fine-grained chapters into a few coarse PARTS (the major phases of the "
    "interview) and write a concrete, information-dense overall summary that "
    "captures the specific events, evidence, findings and motives drawn from "
    "the chapters. Never fall back on generic placeholder phrasing. Output "
    "strict JSON only. (A later pass replaces personal names with roles, so you "
    "may name people here — focus on getting the substance right.)"
)


def _synth_user_prompt(digest: str, n_chapters: int, target_parts: int) -> str:
    # --- OLD summary instruction (kept for easy revert: comment out the active
    #     return below and un-comment this one) ---
    # return (
    #     f"CHAPTERS (each line is '[idx] mm:ss  title — gist'):\n{digest}\n\n"
    #     f"Group these {n_chapters} consecutive chapters into about "
    #     f"{target_parts} top-level PARTS (each a major phase of the interview). "
    #     'Return JSON exactly: {"summary":"<3-6 sentences: what the whole '
    #     'recording covers>","parts":[{"start_idx":<first chapter idx>,'
    #     '"end_idx":<last chapter idx>,"title":"<=8 words","description":'
    #     '"<2-3 sentences describing this section>"}]}. Cover every chapter in '
    #     "order, parts must not overlap, and use the idx numbers shown above."
    # )
    return (
        f"CHAPTERS (each line is '[idx] mm:ss  title — gist'):\n{digest}\n\n"
        f"Group these {n_chapters} consecutive chapters into about "
        f"{target_parts} top-level PARTS (each a major phase of the interview). "
        'Return JSON exactly: {"summary":"<4-6 sentences, specific and grounded '
        'in the chapters above. Cover in order: (1) the core event and who is '
        'involved; (2) the main thread tying it together, e.g. the key evidence '
        'or backstory; (3) the principal suspects and their motives; (4) how it '
        'resolves or where it currently stands. Do NOT use vague filler such as '
        'various aspects, a range of topics, or including.>",'
        '"parts":[{"start_idx":'
        '<first chapter idx>,"end_idx":<last chapter idx>,"title":"<=8 words",'
        '"description":"<2-3 sentences describing this section>"}]}. Cover every '
        "chapter in order, parts must not overlap, and use the idx numbers shown above."
    )


# --- Pass 2: strip personal names from the summary, replacing them with roles.
# A single 7B pass won't honour a "use no names" instruction — it parrots the
# names that fill the chapter digest. A focused rewrite whose ONLY job is
# name -> role is reliable instead. Names are unreliable across recordings (ASR
# mangles them, and they vary by case type), so the overview is kept name-free
# and works for any recording. ---
_DENAME_SYSTEM = (
    "You rewrite a short case summary to remove EVERY personal name. Replace "
    "each person's name with their role in the case (the victim, a suspect, a "
    "witness, the professor, the investigator, a family member). Keep all other "
    "facts, evidence, motives and sentence structure identical. Output strict "
    "JSON only."
)


def _dename_user(summary: str) -> str:
    return (
        f"SUMMARY:\n{summary}\n\n"
        'Return JSON exactly: {"summary":"<the same summary with every personal '
        'name replaced by a role word (the victim, a suspect, a witness, etc.); '
        'change nothing else>"}'
    )


def _dename_summary(summary: str, model: str, ollama_url: str) -> str:
    """Best-effort second pass: rewrite the summary with names -> roles. On any
    failure (Ollama down, bad JSON, empty result) the original summary is kept,
    so the outline never breaks — it may just retain names that one time."""
    if not summary.strip():
        return summary
    try:
        content = _ollama_chat(model, ollama_url, _DENAME_SYSTEM, _dename_user(summary))
        cleaned = str(json.loads(content).get("summary", "")).strip()
        return cleaned or summary
    except Exception:
        return summary


def _normalise_title(t: str) -> str:
    """Lower-case, strip punctuation/extra spaces — used only to detect when two
    adjacent chapters are 'the same topic' for the reduce/merge step."""
    return re.sub(r"[^a-z0-9 ]+", "", (t or "").lower()).strip()


def _mmss(seconds: Any) -> str:
    try:
        s = int(float(seconds))
    except Exception:
        return "0:00"
    return f"{s // 60}:{s % 60:02d}"


def _audio_duration(transcript: Dict[str, Any], segments: List[Dict[str, Any]]) -> float:
    """Total seconds — prefer the declared audioDuration, else the last segment end."""
    d = transcript.get("audioDuration")
    try:
        d = float(d)
        if d > 0:
            return d
    except Exception:
        pass
    ends = [s.get("end") for s in segments if isinstance(s.get("end"), (int, float))]
    return float(max(ends)) if ends else 0.0


def _dynamic_window(seg_words: List[List[Dict[str, Any]]]) -> int:
    """Segments per LLM call, sized so each call carries ~TARGET_MAP_WORDS."""
    n = len(seg_words)
    if n == 0:
        return MIN_WINDOW
    total_words = sum(len(w) for w in seg_words)
    avg = max(1.0, total_words / n)
    win = round(TARGET_MAP_WORDS / avg)
    return max(MIN_WINDOW, min(MAX_WINDOW, win))


def _target_parts(duration_s: float, n_chapters: int) -> int:
    minutes = max(1.0, duration_s / 60.0)
    target = round(1.2 * math.sqrt(minutes))
    target = max(MIN_PARTS, min(MAX_PARTS, target))
    # Never ask for more parts than there are chapters to group.
    return max(1, min(target, n_chapters))


def _coverage(
    parsed: List[Dict[str, Any]], total: int
) -> List[Tuple[int, int, Dict[str, Any]]]:
    """Force a list of {a,b,...} index ranges into CONTIGUOUS, GAP-FREE,
    non-overlapping coverage of [0, total). Each range snaps to where the
    previous one ended (so a skipped index is absorbed into the next range
    rather than vanishing); the first covers the head, the last the tail.
    Returns (a, b, payload) tuples. Shared by the map and synthesis parsers."""
    if total <= 0:
        return []
    parsed = sorted(parsed, key=lambda c: (c["a"], c["b"]))
    covered: List[Tuple[int, int, Dict[str, Any]]] = []
    cursor = 0
    last = total - 1
    for c in parsed:
        if c["b"] < cursor:
            continue  # fully subsumed by an earlier range -> drop
        start = cursor
        if start > last:
            break
        end = min(max(c["b"], start), last)
        covered.append((start, end, c))
        cursor = end + 1
    if not covered:
        covered = [(0, last, {"title": "", "gist": "", "description": ""})]
    # Snap the ends so the whole span is covered.
    first = covered[0]
    covered[0] = (0, first[1], first[2])
    lastc = covered[-1]
    covered[-1] = (lastc[0], last, lastc[2])
    return covered


def _parse_chapters(content: str, ordered_ids: List[Any]) -> List[Dict[str, Any]]:
    """Defensive parse of one map window's JSON. Tolerate stray prose, drop
    unknown ids, clamp ranges to the window, trim text, and force contiguous,
    non-overlapping coverage so the outline has no gaps."""
    data: Any = None
    try:
        data = json.loads(content)
    except Exception:
        try:  # last resort: first {...} block
            s, e = content.index("{"), content.rindex("}")
            data = json.loads(content[s : e + 1])
        except Exception:
            data = None
    raw = data.get("chapters") if isinstance(data, dict) else None

    pos = {sid: i for i, sid in enumerate(ordered_ids)}  # id -> window position
    parsed: List[Dict[str, Any]] = []
    if isinstance(raw, list):
        for c in raw:
            if not isinstance(c, dict):
                continue
            sid, eid = c.get("start_id"), c.get("end_id")
            for key, val in (("start_id", sid), ("end_id", eid)):
                if isinstance(val, str) and val.lstrip("-").isdigit():
                    c[key] = int(val)
            sid, eid = c.get("start_id"), c.get("end_id")
            if sid not in pos or eid not in pos:
                continue
            a, b = pos[sid], pos[eid]
            if a > b:
                a, b = b, a
            parsed.append(
                {
                    "a": a,
                    "b": b,
                    "title": str(c.get("title", "")).strip()[:80],
                    "gist": str(c.get("gist", "")).strip()[:280],
                }
            )

    if not parsed:  # model returned nothing usable -> one chapter for the window
        parsed = [{"a": 0, "b": len(ordered_ids) - 1, "title": "", "gist": ""}]

    out: List[Dict[str, Any]] = []
    for a, b, c in _coverage(parsed, len(ordered_ids)):
        out.append(
            {
                "start_id": ordered_ids[a],
                "end_id": ordered_ids[b],
                "title": c.get("title", ""),
                "gist": c.get("gist", ""),
            }
        )
    return out


def _parse_parts(content: str, n_chapters: int) -> Tuple[str, List[Dict[str, Any]]]:
    """Defensive parse of the synthesis JSON. Returns (summary, parts) where each
    part is {a, b, title, description} with a/b being CHAPTER indices, forced
    into contiguous coverage of [0, n_chapters)."""
    data: Any = None
    try:
        data = json.loads(content)
    except Exception:
        try:
            s, e = content.index("{"), content.rindex("}")
            data = json.loads(content[s : e + 1])
        except Exception:
            data = None
    if not isinstance(data, dict):
        return "", []

    summary = str(data.get("summary", "")).strip()[:1200]
    raw = data.get("parts")
    parsed: List[Dict[str, Any]] = []
    if isinstance(raw, list):
        for p in raw:
            if not isinstance(p, dict):
                continue
            a, b = p.get("start_idx"), p.get("end_idx")
            for key, val in (("start_idx", a), ("end_idx", b)):
                if isinstance(val, str) and val.lstrip("-").isdigit():
                    p[key] = int(val)
            a, b = p.get("start_idx"), p.get("end_idx")
            if not isinstance(a, int) or not isinstance(b, int):
                continue
            a = max(0, min(n_chapters - 1, a))
            b = max(0, min(n_chapters - 1, b))
            if a > b:
                a, b = b, a
            parsed.append(
                {
                    "a": a,
                    "b": b,
                    "title": str(p.get("title", "")).strip()[:100],
                    "description": str(p.get("description", "")).strip()[:600],
                }
            )

    parts = [
        {"a": a, "b": b, "title": c.get("title", ""), "description": c.get("description", "")}
        for a, b, c in _coverage(parsed, n_chapters)
    ]
    return summary, parts


def _cached_chapters(
    numbered: str,
    ordered_ids: List[Any],
    model: str,
    ollama_url: str,
    cache: Optional[Path],
) -> List[Dict[str, Any]]:
    """Chapters for one map window — from the on-disk cache if present, else by
    calling Ollama once and caching the parsed result."""
    path = None
    if cache is not None:
        key = hashlib.sha256(
            "\x00".join([model, numbered, "map-v3"]).encode("utf-8")
        ).hexdigest()
        path = cache / f"{key}.json"
        if path.exists():
            try:
                return json.loads(path.read_text())
            except Exception:
                pass  # corrupt entry -> recompute
    content = _ollama_chat(model, ollama_url, _MAP_SYSTEM, _map_user_prompt(numbered))
    chapters = _parse_chapters(content, ordered_ids)
    if path is not None:
        try:
            path.write_text(json.dumps(chapters))
        except Exception:
            pass
    return chapters


def _ollama_chat_retry(
    model: str, ollama_url: str, system: str, user: str, attempts: int = 3
) -> str:
    """_ollama_chat with retries. A crashed llama runner (the 'broken pipe' seen
    under memory pressure) often recovers on the next attempt, so one transient
    crash no longer blanks the whole synthesis / overview. On exhaustion the last
    OllamaError propagates (caller falls back)."""
    last: Optional[Exception] = None
    for i in range(attempts):
        try:
            return _ollama_chat(model, ollama_url, system, user)
        except OllamaError as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise last  # type: ignore[misc]


def _cached_synthesis(
    digest: str,
    n_chapters: int,
    target_parts: int,
    model: str,
    ollama_url: str,
    cache: Optional[Path],
) -> Tuple[str, List[Dict[str, Any]]]:
    """Summary + Part grouping over the compact chapter list — cached on disk."""
    path = None
    if cache is not None:
        key = hashlib.sha256(
            # bump the version tag whenever the synthesis prompt changes, so a
            # re-run regenerates instead of returning the stale cached summary.
            "\x00".join([model, digest, str(target_parts), "synthesis-v3"]).encode("utf-8")
        ).hexdigest()
        path = cache / f"{key}.json"
        if path.exists():
            try:
                blob = json.loads(path.read_text())
                return blob.get("summary", ""), blob.get("parts", [])
            except Exception:
                pass
    content = _ollama_chat_retry(
        model, ollama_url, _SYNTH_SYSTEM, _synth_user_prompt(digest, n_chapters, target_parts)
    )
    summary, parts = _parse_parts(content, n_chapters)
    # Pass 2: replace personal names with roles (kept name-free for robustness
    # across recordings). Cached below, so repeat calls pay no extra LLM cost.
    summary = _dename_summary(summary, model, ollama_url)
    if path is not None:
        try:
            path.write_text(json.dumps({"summary": summary, "parts": parts}))
        except Exception:
            pass
    return summary, parts


def _fallback_parts(
    chapters: List[Dict[str, Any]], target_parts: int
) -> List[Dict[str, Any]]:
    """Even-by-duration Part grouping used when the synthesis LLM is unavailable
    (e.g. Ollama died after the map cache was warmed). No summary/descriptions,
    but the two-level outline still works and every chapter is reachable."""
    n = len(chapters)
    if n == 0:
        return []
    k = max(1, min(target_parts, n))
    parts: List[Dict[str, Any]] = []
    for i in range(k):
        a = (i * n) // k
        b = ((i + 1) * n) // k - 1
        if b < a:
            continue
        parts.append({"a": a, "b": b, "title": "", "description": ""})
    return parts


def run_outline(
    transcript: Dict[str, Any],
    *,
    pick_model: Callable[[Dict[str, Any], Optional[str]], str],
    model: str,
    ollama_url: str,
    window: Optional[int] = None,
    cache_dir: Optional[Any] = None,
) -> Dict[str, Any]:
    """Build a two-level outline + summary over the whole transcript.

    Returns {"summary", "parts": [{id, title, description, start_id, end_id,
    segment_start, segment_end, chapters: [{id, title, gist, start_id, end_id,
    segment_start, segment_end}]}], "_model", "_window", "_target_parts"}.

    Map (Ollama) is a hard dependency: if it cannot run and nothing is cached an
    OllamaError propagates. The synthesis pass degrades gracefully — if it fails
    the Parts are grouped by duration and the summary is left empty.
    """
    segments = transcript.get("segments") or []
    if not segments:
        return {"summary": "", "parts": [], "_model": model, "_window": 0, "_target_parts": 0}

    seg_words = _segment_words(transcript, pick_model)
    id_to_idx = {seg.get("id"): i for i, seg in enumerate(segments)}

    cache: Optional[Path] = None
    if cache_dir is not None:
        cache = Path(cache_dir)
        cache.mkdir(parents=True, exist_ok=True)

    win = int(window) if window else _dynamic_window(seg_words)
    win = max(1, win)

    # ----- MAP: dynamic non-overlapping windows, each chaptered independently --
    raw_chapters: List[Dict[str, Any]] = []
    for start in range(0, len(segments), win):
        w_segs = segments[start : start + win]
        w_words = seg_words[start : start + win]
        numbered = _numbered_transcript(w_segs, w_words)
        ordered_ids = [s.get("id") for s in w_segs]
        raw_chapters.extend(
            _cached_chapters(numbered, ordered_ids, model, ollama_url, cache)
        )

    # ----- REDUCE-1: merge adjacent chapters with the same normalised title
    # (a topic split across a window boundary) into one. -----
    merged: List[Dict[str, Any]] = []
    for c in raw_chapters:
        if merged and _normalise_title(c["title"]) == _normalise_title(merged[-1]["title"]):
            merged[-1]["end_id"] = c["end_id"]
            if not merged[-1]["gist"]:
                merged[-1]["gist"] = c["gist"]
            continue
        merged.append(dict(c))

    # Attach time ranges + a 1-based global chapter id.
    chapters: List[Dict[str, Any]] = []
    for i, c in enumerate(merged):
        a = segments[id_to_idx[c["start_id"]]]
        b = segments[id_to_idx[c["end_id"]]]
        chapters.append(
            {
                "id": i + 1,
                "start_id": c["start_id"],
                "end_id": c["end_id"],
                "segment_start": a.get("start"),
                "segment_end": b.get("end"),
                "title": c["title"] or f"Segments {c['start_id']}–{c['end_id']}",
                "gist": c["gist"],
            }
        )

    # ----- SYNTHESIS: group chapters into Parts + write summary (degradable) ---
    duration = _audio_duration(transcript, segments)
    target = _target_parts(duration, len(chapters))
    digest = "\n".join(
        f"[{i}] {_mmss(c['segment_start'])}  {c['title']} — {c['gist']}"
        for i, c in enumerate(chapters)
    )
    try:
        summary, part_ranges = _cached_synthesis(
            digest, len(chapters), target, model, ollama_url, cache
        )
    except OllamaError:
        summary, part_ranges = "", _fallback_parts(chapters, target)
    if not part_ranges:
        part_ranges = _fallback_parts(chapters, target)

    parts: List[Dict[str, Any]] = []
    for i, pr in enumerate(part_ranges):
        a, b = pr["a"], pr["b"]
        kids = chapters[a : b + 1]
        if not kids:
            continue
        parts.append(
            {
                "id": i + 1,
                "start_id": kids[0]["start_id"],
                "end_id": kids[-1]["end_id"],
                "segment_start": kids[0]["segment_start"],
                "segment_end": kids[-1]["segment_end"],
                "title": pr["title"] or f"Part {i + 1}",
                "description": pr.get("description", ""),
                "chapters": kids,
            }
        )

    return {
        "summary": summary,
        "parts": parts,
        "_model": model,
        "_window": win,
        "_target_parts": target,
    }


# Re-export so callers can `from outline import OllamaError`.
__all__ = ["run_outline", "OllamaError"]
