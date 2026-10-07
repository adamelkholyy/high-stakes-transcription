"""Local AI assistant chat over one transcript.

Ollama answers the reviewer's questions about the loaded transcript,
multi-turn, with every factual claim grounded in segment
citations that are VALIDATED server-side (unknown ids dropped, quotes
checked against the segment text). In the default local setup nothing leaves
the machine; nothing is cached (unlike /focus_llm and /outline there is no
study-freezing need and a multi-turn cache key would never hit).

Design guardrails (this is a forensic tool, not a general chatbot):
  * the model must answer ONLY from the transcript, and must say so plainly
    when the transcript does not contain the answer;
  * schema drift degrades to an answer without citations — never a 500;
  * the frontend renders zero-citation answers with a caution note and keeps
    the whole conversation out of the audit trail and all exports.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional, Set

import httpx

# Reuse the proven transcript helpers rather than duplicating them. Chat keeps
# its own messages-based Ollama client for multi-turn context and num_ctx.
from focus_llm import (  # noqa: F401
    OllamaError,
    _numbered_transcript,
    _segment_words,
)

# Context window: Ollama's default num_ctx (often 4k) would silently truncate
# the transcript head on a ~36-min interview (~8k tokens numbered). qwen2.5:7b
# supports 32k; we cap at 16k (≤~1h of speech) and pick the SMALLEST bucket
# that fits per request — a smaller KV cache is lighter on memory and avoids
# needless runner reloads, both of which trigger the "llama runner terminated:
# broken pipe" crash seen under memory pressure (same failure outline.py
# retries for).
NUM_CTX_BUCKETS = (4096, 8192, 16384)
MAX_NUM_CTX = NUM_CTX_BUCKETS[-1]
# Rough chars-per-token for conversational English on qwen2.5 (conservative).
_CHARS_PER_TOKEN = 3.5
_OUTPUT_TOKEN_BUDGET = 600


def _pick_num_ctx(prompt_chars: int) -> int:
    """Smallest context bucket that fits the prompt with ~20% headroom."""
    est_tokens = int(prompt_chars / _CHARS_PER_TOKEN) + _OUTPUT_TOKEN_BUDGET
    for size in NUM_CTX_BUCKETS:
        if est_tokens * 1.2 <= size:
            return size
    return MAX_NUM_CTX

# History discipline: keep the last N turns before the final user message,
# each capped, so a long conversation cannot crowd the transcript out of the
# context window. The client trims too; this is the server-side guarantee.
MAX_HISTORY_TURNS = 6
MAX_TURN_CHARS = 2000
MAX_ANSWER_CHARS = 2000
MAX_CITATIONS = 8

_SYSTEM_RULES = (
    "You are an assistant helping a police-interview reviewer understand ONE "
    "transcript. The numbered transcript ('[id] text' per line) is below. "
    "Answer the reviewer's LAST message using ONLY what the transcript says.\n"
    "Rules:\n"
    "- Every factual claim must cite the segment(s) it comes from.\n"
    "- If the transcript does not contain the answer, say so plainly (e.g. "
    "'The transcript does not mention this.') and return an empty citations "
    "list. Never guess, infer beyond the text, or use outside knowledge.\n"
    "- 'quote' must be verbatim words from that segment, at most 15 words.\n"
    "- Be concise: one to four sentences.\n"
    "Output strict JSON only, exactly: "
    '{"answer": "<text>", "citations": [{"id": <segment number>, '
    '"quote": "<verbatim, <=15 words>"}]}\n\n'
    "TRANSCRIPT:\n"
)


def _ollama_chat_messages(
    model: str,
    ollama_url: str,
    messages: List[Dict[str, str]],
    num_ctx: int = MAX_NUM_CTX,
) -> str:
    """Like focus_llm._ollama_chat but with a full messages list and an
    explicit num_ctx for multi-turn and long-context needs."""
    body = {
        "model": model,
        "messages": messages,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "seed": 0, "num_ctx": num_ctx},
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


def _chat_with_retry(
    model: str,
    ollama_url: str,
    messages: List[Dict[str, str]],
    num_ctx: int,
    attempts: int = 3,
) -> str:
    """Same rationale as outline._ollama_chat_retry: a crashed llama runner
    (the 'broken pipe' seen under memory pressure) often recovers on the next
    attempt, so one user question shouldn't fail on a transient crash."""
    last: Optional[OllamaError] = None
    for i in range(attempts):
        try:
            return _ollama_chat_messages(model, ollama_url, messages, num_ctx)
        except OllamaError as e:
            last = e
            if i < attempts - 1:
                time.sleep(1.5 * (i + 1))
    assert last is not None
    raise last


def _norm(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — for quote checks."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", "", s.lower())).strip()


def _parse_reply(content: str) -> Dict[str, Any]:
    """Defensive parse of the model's JSON reply. Never raises: schema drift
    degrades to an answer without citations."""
    data: Any = None
    try:
        data = json.loads(content)
    except Exception:
        try:  # last resort: first {...} block
            s, e = content.index("{"), content.rindex("}")
            data = json.loads(content[s : e + 1])
        except Exception:
            data = None
    if not isinstance(data, dict):
        # Not JSON at all — treat the raw content as the answer text.
        return {"answer": str(content).strip()[:MAX_ANSWER_CHARS], "citations": []}
    answer = str(data.get("answer", "")).strip()[:MAX_ANSWER_CHARS]
    raw_citations = data.get("citations")
    citations = raw_citations if isinstance(raw_citations, list) else []
    if not answer:
        # Some drifted replies put the text under another key; salvage the
        # longest string value rather than returning an empty bubble.
        strings = [str(v).strip() for v in data.values() if isinstance(v, str) and str(v).strip()]
        answer = max(strings, key=len)[:MAX_ANSWER_CHARS] if strings else ""
    return {"answer": answer, "citations": citations}


def run_chat(
    transcript: Dict[str, Any],
    messages: List[Dict[str, str]],
    *,
    pick_model,
    model: str,
    ollama_url: str,
    max_turns: int = MAX_HISTORY_TURNS,
    num_ctx: Optional[int] = None,  # None -> smallest bucket that fits
) -> Dict[str, Any]:
    """Answer the last user message over the numbered transcript, grounded in
    validated segment citations."""
    segments = transcript.get("segments") or []
    seg_words = _segment_words(transcript, pick_model)
    numbered = _numbered_transcript(segments, seg_words)
    valid_ids: Set[Any] = {seg.get("id") for seg in segments}
    id_to_idx = {seg.get("id"): i for i, seg in enumerate(segments)}

    # Server-side history truncation (client trims too): last `max_turns`
    # turns before the final user message, each capped.
    history = [
        {"role": m["role"], "content": (m.get("content") or "")[:MAX_TURN_CHARS]}
        for m in messages[:-1]
        if m.get("role") in ("user", "assistant")
    ][-max_turns:]
    final = {
        "role": "user",
        "content": (messages[-1].get("content") or "")[:MAX_TURN_CHARS],
    }

    system = _SYSTEM_RULES + numbered
    chat_messages = [{"role": "system", "content": system}, *history, final]
    if num_ctx is None:
        num_ctx = _pick_num_ctx(sum(len(m["content"]) for m in chat_messages))
    content = _chat_with_retry(model, ollama_url, chat_messages, num_ctx)
    parsed = _parse_reply(content)

    # Citation validation: only ids that exist in THIS transcript survive; the
    # seek time and evidence text come from the transcript, never the model.
    citations: List[Dict[str, Any]] = []
    seen: Set[Any] = set()
    for c in parsed["citations"]:
        if not isinstance(c, dict):
            continue
        sid = c.get("id")
        if isinstance(sid, str) and sid.lstrip("-").isdigit():
            sid = int(sid)
        if sid not in valid_ids or sid in seen:
            continue
        seen.add(sid)
        idx = id_to_idx[sid]
        seg = segments[idx]
        evidence = " ".join(w.get("text", "") for w in seg_words[idx]).strip()
        quote = str(c.get("quote", "")).strip()[:200]
        # Quote is decoration: keep the (verified) citation, blank the quote
        # if it is not actually verbatim from the segment.
        if quote and _norm(quote) not in _norm(evidence):
            quote = ""
        citations.append(
            {
                "id": sid,
                "segment_start": seg.get("start"),
                "evidence": evidence,
                "quote": quote,
            }
        )
        if len(citations) >= MAX_CITATIONS:
            break

    return {"answer": parsed["answer"], "citations": citations, "model": model}
