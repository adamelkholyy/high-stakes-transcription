"""
focus_llm.py
Component 2b — LLM-assisted case-focus retrieval ("AI" mode).

An *inference-only* alternative to the deterministic lexical retriever in
focus.py. A LOCAL LLM (via Ollama) reads the WHOLE transcript in context and
returns the segments genuinely *about* a free-text query — including lines that
never use the query's words but refer to it through pronouns or an earlier
mention (the cross-sentence context that single-sentence embeddings lose). The
same box handles a bare keyword and a full plain-English intent.

It trains nothing and nothing leaves the machine (local Ollama), so the
ML/HCI boundary is unchanged. It returns the SAME FocusResult/FocusSnippet
shape as focus.py — match_type="llm" plus two optional fields
(llm_relevance_score, llm_reason) — so the entire front-end overlay (violet
markers, HIGH upgrade, reversible "Clear focus", snippet->audio seek) is reused.

Reproducibility for the user study comes from temperature 0 + a fixed seed AND
an on-disk cache keyed by (model, numbered-transcript, query). The cache stores
the model's raw judgments; threshold/top_k are applied on read, so tuning them
never triggers a new call. Committing the cache freezes the judgments exactly.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

import httpx

# Reuse the deterministic core rather than duplicating it.
from focus import _content_indices, original_combined_risk

class OllamaError(RuntimeError):
    """Raised when the local Ollama service is unreachable or misconfigured."""


_SYSTEM = (
    "You help a police-interview reviewer locate evidence. Given a numbered "
    "transcript and a focus query (a keyword or a plain-English description), "
    "return ONLY segments genuinely about the query — INCLUDING ones that do "
    "not contain the query's words but refer to it via context, pronouns, or an "
    "earlier mention. Be precise: skip loosely-related or generic lines. Output "
    "strict JSON only."
)


def _user_prompt(query: str, numbered: str) -> str:
    return (
        f"QUERY: {query}\n\nTRANSCRIPT:\n{numbered}\n\n"
        'Return JSON exactly: {"matches":[{"id":<segment number>,'
        '"score":<0.0-1.0>,"reason":"<=12 words"}]}. '
        "Empty list if nothing matches."
    )


def _segment_words(transcript: Dict[str, Any], pick_model) -> List[List[Dict[str, Any]]]:
    segs = transcript.get("segments") or []
    return [seg["words"][pick_model(seg, None)] for seg in segs]


def _numbered_transcript(segments: List[Dict[str, Any]], seg_words) -> str:
    """`[id] sentence` per segment — uses real seg ids so the model's `id`
    references map straight back to segments."""
    lines = []
    for seg, words in zip(segments, seg_words):
        text = " ".join(w.get("text", "") for w in words).strip()
        lines.append(f"[{seg.get('id')}] {text}")
    return "\n".join(lines)


def _parse_matches(content: str, valid_ids: Set[Any]) -> List[Dict[str, Any]]:
    """Defensive parse of the model's JSON: tolerate stray prose, drop unknown
    or duplicate ids, clamp scores to [0,1], trim reasons."""
    data: Any = None
    try:
        data = json.loads(content)
    except Exception:
        try:  # last resort: first {...} block
            s, e = content.index("{"), content.rindex("}")
            data = json.loads(content[s : e + 1])
        except Exception:
            return []
    raw = data.get("matches") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    seen: Set[Any] = set()
    for m in raw:
        if not isinstance(m, dict):
            continue
        sid = m.get("id")
        if isinstance(sid, str) and sid.lstrip("-").isdigit():
            sid = int(sid)
        if sid not in valid_ids or sid in seen:
            continue
        seen.add(sid)
        try:
            score = float(m.get("score", 0.0))
        except Exception:
            score = 0.0
        score = max(0.0, min(1.0, score))
        reason = str(m.get("reason", "")).strip()[:200]
        out.append({"id": sid, "score": score, "reason": reason})
    return out


def _ollama_chat(model: str, ollama_url: str, system: str, user: str) -> str:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "seed": 0},
    }
    try:
        r = httpx.post(f"{ollama_url}/api/chat", json=body, timeout=180.0)
    except Exception as e:
        raise OllamaError(
            f"Ollama not reachable at {ollama_url}. Run `ollama serve` and "
            f"`ollama pull {model}`. ({e})"
        )
    if r.status_code == 404:
        raise OllamaError(f"Model '{model}' not found in Ollama. Run `ollama pull {model}`.")
    if r.status_code >= 400:
        raise OllamaError(f"Ollama returned HTTP {r.status_code}: {r.text[:200]}")
    return r.json().get("message", {}).get("content", "") or ""


def _cached_or_call(
    query: str,
    numbered: str,
    model: str,
    ollama_url: str,
    valid_ids: Set[Any],
    cache: Optional[Path],
) -> List[Dict[str, Any]]:
    """Return the model's raw matches for (model, transcript, query), from the
    on-disk cache if present, else by calling Ollama and caching the result.
    The cache key intentionally excludes threshold/top_k (applied on read)."""
    path = None
    if cache is not None:
        key = hashlib.sha256("\x00".join([model, numbered, query]).encode("utf-8")).hexdigest()
        path = cache / f"{key}.json"
        if path.exists():
            try:
                return json.loads(path.read_text())
            except Exception:
                pass  # corrupt cache entry -> recompute
    content = _ollama_chat(model, ollama_url, _SYSTEM, _user_prompt(query, numbered))
    matches = _parse_matches(content, valid_ids)
    if path is not None:
        try:
            path.write_text(json.dumps(matches))
        except Exception:
            pass
    return matches


def run_focus_llm(
    transcript: Dict[str, Any],
    queries: List[str],
    *,
    pick_model: Callable[[Dict[str, Any], Optional[str]], str],
    clean_for_model: Callable[[str], str],
    model: str,
    ollama_url: str,
    threshold: float = 0.5,
    top_k: int = 8,
    cache_dir: Optional[Any] = None,
) -> Dict[str, Any]:
    """LLM retrieval over the whole transcript. Returns the same shape as
    focus.run_focus (terms -> snippets), with match_type="llm" and the extra
    llm_relevance_score / llm_reason fields."""
    segments = transcript.get("segments") or []
    seg_words = _segment_words(transcript, pick_model)
    numbered = _numbered_transcript(segments, seg_words)
    valid_ids: Set[Any] = {seg.get("id") for seg in segments}
    id_to_idx = {seg.get("id"): i for i, seg in enumerate(segments)}

    cache: Optional[Path] = None
    if cache_dir is not None:
        cache = Path(cache_dir)
        cache.mkdir(parents=True, exist_ok=True)

    terms_out: List[Dict[str, Any]] = []
    for raw_q in queries:
        q = (raw_q or "").strip()
        if not q:
            continue
        matches = _cached_or_call(q, numbered, model, ollama_url, valid_ids, cache)
        snippets: List[Dict[str, Any]] = []
        for m in matches:
            if m["score"] < threshold:
                continue
            idx = id_to_idx.get(m["id"])
            if idx is None:
                continue
            seg = segments[idx]
            words = seg_words[idx]
            snippets.append(
                {
                    "segment_id": seg.get("id"),
                    "segment_start": seg.get("start"),
                    "match_type": "llm",
                    "match_detail": None,
                    "focus_score": round(m["score"], 4),
                    "llm_relevance_score": round(m["score"], 4),
                    "llm_reason": m["reason"],
                    "evidence": " ".join(w.get("text", "") for w in words).strip(),
                    "highlight_word_indices": _content_indices(words, clean_for_model),
                    "highlight_spans": [],
                    "original_combined_risk": original_combined_risk(seg, words),
                }
            )
        snippets.sort(key=lambda s: s["focus_score"], reverse=True)
        terms_out.append(
            {"focus_label": q, "query": q, "auto_aliases": [], "snippets": snippets[:top_k]}
        )

    return {"terms": terms_out, "_threshold": threshold, "_top_k": top_k, "_model": model}
