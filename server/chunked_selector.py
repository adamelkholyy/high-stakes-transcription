# Windowed wrapper around transcribe_api.run_selector.
#
# run_selector calls qwen2.5:7b with a fixed num_ctx=4096. A full ~27-min
# transcript (3 hypotheses ≈ 15k+ tokens) overflows that window, so the selector
# truncates and drops ~2/3 of the text + all punctuation. Windowing the
# transcript into ~600-word chunks (a 5-min clip ≈ 650 words fits 4096 cleanly)
# and stitching keeps every chunk inside the context window.
#
# `run_selector_fn` is passed in (transcribe_api.run_selector) so this module is
# import-safe and unit-testable without loading the ASR models.
import re

MAX_SELECTOR_WORDS = 600


def _fallback_confs(text):
    """The selector returned NO per-sentence confidences for this chunk — it threw
    and fell back to the raw WhisperX text, or emitted no CONFIDENCE block. Without
    this, that chunk's sentences vanish from the structured `segments`
    (assign_sentences_to_speakers builds them ONLY from confidences), silently
    dropping ~600 words with no error. Instead emit the chunk as sentence(s)
    flagged low-confidence (score 2/5) so the passages surface for review rather
    than disappearing. `idx` is a placeholder — run_selector_chunked renumbers it
    globally."""
    text = (text or "").strip()
    if not text:
        return []
    sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()] or [text]
    return [
        {"idx": k, "score": 2, "confidence": 2 / 5.0, "sentence": s, "selector_failed": True}
        for k, s in enumerate(sents, 1)
    ]


def _proportional_slice(words, i, j, n):
    """The [i,j) span of the WhisperX word range, mapped proportionally onto a
    different hypothesis' word list (qwen / parakeet carry no per-word timings)."""
    if not words:
        return ""
    a = round(i / n * len(words))
    b = round(j / n * len(words))
    return " ".join(words[a:b])


def run_selector_chunked(run_selector_fn, client, whisper_hyp, qwen_hyp, parakeet_hyp,
                         max_words=MAX_SELECTOR_WORDS):
    """Windowed run_selector: keeps every call inside the selector's context
    window (Ollama num_ctx=4096) and its output short enough to finish.
    WhisperX is the anchor; qwen / parakeet are sliced proportionally. An empty
    hypothesis falls back to the WhisperX chunk."""
    wx_words = whisper_hyp.split()
    qw_words = qwen_hyp.split() if qwen_hyp else []
    pk_words = parakeet_hyp.split() if parakeet_hyp else []
    n = len(wx_words)
    if n == 0:
        return whisper_hyp, []
    n_chunks = (n + max_words - 1) // max_words
    parts, confs_all, idx = [], [], 0
    for ci in range(n_chunks):
        i, j = ci * max_words, min(ci * max_words + max_words, n)
        wx_chunk = " ".join(wx_words[i:j])
        qw_chunk = _proportional_slice(qw_words, i, j, n) or wx_chunk
        pk_chunk = _proportional_slice(pk_words, i, j, n) or wx_chunk
        print(f"[chunk] selector {ci + 1}/{n_chunks} ({j - i} words)", flush=True)
        t, confs = run_selector_fn(client, wx_chunk, qw_chunk, pk_chunk)
        if not confs and wx_chunk.strip():
            # Selection failed/empty for this chunk — preserve the text as
            # low-confidence sentences so it isn't silently lost from `segments`.
            print(f"[chunk] selector {ci + 1}/{n_chunks} returned no confidences — "
                  f"preserving {j - i} words as low-confidence fallback", flush=True)
            confs = _fallback_confs(t or wx_chunk)
        parts.append(t)
        for c in confs:
            idx += 1
            c = dict(c)
            c["idx"] = idx
            confs_all.append(c)
    return " ".join(p for p in parts if p).strip(), confs_all
