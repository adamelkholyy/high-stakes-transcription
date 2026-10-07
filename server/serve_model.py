"""
serve_model.py
FastAPI service that predicts per-word semantic importance for a transcript
and combines it with the uncertainty signal already present in the JSON
(the original `risk` field) into a 2x2 `combined_risk`.

Run:
    uvicorn serve_model:app --port 8000

The classifier and encoder are loaded once at startup and held in module
globals.

Two orthogonal risk dimensions:
  - uncertainty: confidence-based, computed upstream, lives in word["risk"]
  - importance:  semantic-severity, predicted here from MiniLM embeddings
The reviewer-facing `combined_risk` is f(uncertainty, importance) — see
`combine()` for the 2x2 policy.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
# `sentence_transformers` is imported lazily inside get_encoder() so Ollama-only
# routes can start without loading the local embedding model.

import anomaly as anomaly_mod
import chat as chat_mod
import focus as focus_mod
import focus_llm as focus_llm_mod
import outline as outline_mod
import timeline as timeline_mod
import triage as triage_mod
from l1_rules import l1_label


# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------

# Default to the vendored copy that ships in server/models/ so a fresh clone
# runs out-of-the-box. Resolved relative to this file so the cwd uvicorn is
# launched from doesn't matter. Override with IMPORTANCE_MODEL_PATH when
# pointing at a newer artefact (e.g. the one under modelData/).
_DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / "models" / "l2_clean.joblib"
MODEL_PATH = Path(os.environ.get("IMPORTANCE_MODEL_PATH", str(_DEFAULT_MODEL_PATH)))
ENCODER_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# Classifier emits HIGH/MEDIUM/LOW; front-end consumes lowercase high/med/low.
RISK_MAP = {"HIGH": "high", "MEDIUM": "med", "LOW": "low"}


# ---------------------------------------------------------------------------
# Classifier (eager — tiny joblib, torch-free) + encoder (lazy — torch, heavy).
# The encoder loads only on the first /predict or semantic /focus request.
# ---------------------------------------------------------------------------

print(f"[serve_model] Loading classifier: {MODEL_PATH}")
clf = joblib.load(MODEL_PATH)
print(f"[serve_model] Classes: {list(clf.classes_)}  n_features={clf.n_features_in_}")

_encoder = None


def get_encoder():
    """Lazily import + load the SentenceTransformer encoder (torch) on first use."""
    global _encoder
    if _encoder is None:
        from sentence_transformers import SentenceTransformer  # defers torch import

        print(f"[serve_model] Loading encoder: {ENCODER_NAME}")
        _encoder = SentenceTransformer(ENCODER_NAME)
    return _encoder

# Index of each class label in clf.classes_ so we can map predict_proba columns
# back to high/med/low without depending on alphabetical order.
_CLASS_IDX = {label: i for i, label in enumerate(clf.classes_)}


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

_PUNCT_STRIP = '.,!?;:"\'()[]'


def clean_for_model(text: str) -> str:
    """Strip leading/trailing punctuation so the token matches training
    distribution. Keeps internal hyphens/apostrophes (forty-two, didn't)."""
    return text.strip().strip(_PUNCT_STRIP).strip()


def build_context(words: List[Dict[str, Any]], i: int) -> str:
    """Reconstruct the `[TARGET] word [/TARGET]` context string for word i.

    Matches the format produced during training (see modelData/train_l1_l2.py):
    single spaces around the markers, surrounding tokens space-joined.
    """
    cleaned = [clean_for_model(w["text"]) for w in words]
    before = " ".join(cleaned[:i])
    target = cleaned[i]
    after = " ".join(cleaned[i + 1 :])
    return f"{before} [TARGET] {target} [/TARGET] {after}".strip()


# ---------------------------------------------------------------------------
# Importance cascade + combine  (★ research-relevant — adjust here)
# ---------------------------------------------------------------------------
#
# HIGH importance is gated by the L1 statutory-lexicon rules (cascade "C2_gate":
# HIGH iff L1 fires, else the better of MEDIUM/LOW from the L2 classifier). On
# the human gold set this lifts HIGH-precision 0.45 -> 0.95 vs. the raw L2, and
# it removes the "everything-is-red" flood that the previous P(HIGH) >= 0.75
# gate produced on semantically dense passages (measured: a dense interview clip
# went 26% red -> ~9%, while the procedural demo stayed ~7%). The L2's own HIGH
# probability is deliberately NOT used to grant HIGH — it over-fires.


def cascade_importance(l1: str, p_med: float, p_low: float) -> str:
    """C2_gate: HIGH iff the L1 rules fire; otherwise the better of MEDIUM/LOW
    from the L2 probabilities. Returns lowercase high/med/low."""
    if l1 == "HIGH":
        return "high"
    return "med" if p_med >= p_low else "low"


def combine(uncertainty: str, importance: str) -> str:
    """Reviewer-facing 2x2 of importance (from the cascade) x uncertainty.

    uncertainty: word["risk"] — confidence-based, from the upstream ASR pipeline.
    importance:  high/med/low from `cascade_importance`.

                         uncertainty=low  uncertainty=med  uncertainty=high
      importance=high          HIGH            HIGH             HIGH
      importance=med           MED             MED              HIGH
      importance=low           LOW             MED              MED

    Red (HIGH) requires HIGH importance, or medium-importance coinciding with
    high uncertainty; uncertainty alone never reaches red. All gates tunable.
    """
    rank = {"low": 0, "med": 1, "high": 2}
    u = rank[uncertainty]
    if importance == "high":
        return "high"
    if importance == "med":
        return "high" if u == 2 else "med"
    return "med" if u >= 1 else "low"


# ---------------------------------------------------------------------------
# Model picking
# ---------------------------------------------------------------------------

def pick_model(segment: Dict[str, Any], requested: Optional[str]) -> str:
    words = segment.get("words") or {}
    if requested and requested in words:
        return requested
    for k in words:
        if "Consensus" in k:
            return k
    if not words:
        raise HTTPException(
            status_code=400,
            detail=f"segment id={segment.get('id')} has no model entries under 'words'.",
        )
    return next(iter(words))


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="importance-classifier", version="1.0.0")

# The public artifact accepts browser requests only from local development
# origins. This keeps transcript processing on the same machine.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


class Health(BaseModel):
    status: str
    model_loaded: bool
    classes: List[str]
    encoder: str


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(
        status="ok",
        model_loaded=clf is not None,
        classes=list(clf.classes_),
        encoder=ENCODER_NAME,
    )


@app.post("/predict")
def predict(transcript: Dict[str, Any], model_name: Optional[str] = None) -> Dict[str, Any]:
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")

    # Deep copy so we never mutate the caller's payload.
    out = copy.deepcopy(transcript)

    # ----- Pass 1: collect everything that needs the model -----
    # Per-segment selected model name (so the response can echo it back if
    # callers want to know which model branch was annotated).
    seg_model_name: List[str] = []
    contexts: List[str] = []
    targets: List[str] = []
    # (seg_idx, word_idx) for each pending prediction, in the same order as
    # contexts/targets — used to write predictions back in pass 2.
    pending: List[Tuple[int, int]] = []

    for s_idx, seg in enumerate(out["segments"]):
        mname = pick_model(seg, model_name)
        seg_model_name.append(mname)
        words = seg["words"][mname]
        for w_idx, w in enumerate(words):
            cleaned = clean_for_model(w.get("text", ""))
            if cleaned == "":
                # Pure-punctuation token — skip the model entirely. Annotated
                # in pass 2 with a trivial importance=low.
                continue
            contexts.append(build_context(words, w_idx))
            targets.append(cleaned)
            pending.append((s_idx, w_idx))

    # ----- Single batched encode for the whole transcript -----
    if pending:
        enc = get_encoder()
        ctx_emb = enc.encode(contexts, batch_size=64, convert_to_numpy=True)
        tgt_emb = enc.encode(targets, batch_size=64, convert_to_numpy=True)
        X = np.concatenate([ctx_emb, tgt_emb], axis=1)
        probs = clf.predict_proba(X)  # shape (N, 3) in clf.classes_ order
    else:
        probs = np.zeros((0, len(clf.classes_)))

    # Convenience: column index for each importance class
    i_high = _CLASS_IDX["HIGH"]
    i_med = _CLASS_IDX["MEDIUM"]
    i_low = _CLASS_IDX["LOW"]

    # ----- Pass 2: write predictions back into the (selected model's) words -----
    # Index into pending/probs as we walk in the same order.
    p_cursor = 0
    for s_idx, seg in enumerate(out["segments"]):
        mname = seg_model_name[s_idx]
        words = seg["words"][mname]
        for w_idx, w in enumerate(words):
            cleaned = clean_for_model(w.get("text", ""))
            uncertainty = w.get("risk", "low")
            if cleaned == "":
                # Pure punctuation: skip the model entirely. We hand back the
                # upstream uncertainty as-is rather than route it through
                # combine() — punctuation has no meaningful importance signal
                # and we don't want the gating logic to massage it.
                w["predicted_importance"] = "low"
                w["predicted_proba"] = {"high": 0.0, "med": 0.0, "low": 1.0}
                w["combined_risk"] = uncertainty
                continue

            assert pending[p_cursor] == (s_idx, w_idx)
            p_row = probs[p_cursor]
            p_cursor += 1

            proba = {
                "high": float(p_row[i_high]),
                "med": float(p_row[i_med]),
                "low": float(p_row[i_low]),
            }
            # L1-gated cascade. The previous raw token drives the proper-noun
            # sentence-start test (build_context strips the punctuation l1 needs).
            prev_raw = words[w_idx - 1].get("text", "") if w_idx > 0 else None
            l1 = l1_label(w.get("text", ""), prev_raw, w_idx == 0)
            importance = cascade_importance(l1, proba["med"], proba["low"])
            w["predicted_importance"] = importance
            w["predicted_proba"] = proba
            w["predicted_importance_source"] = "l1" if l1 == "HIGH" else "l2"
            w["combined_risk"] = combine(uncertainty, importance)

    out["_annotated_models"] = seg_model_name
    return out


# ---------------------------------------------------------------------------
# Component 2b — case-focused evidence retrieval (retrieval overlay, no training)
# ---------------------------------------------------------------------------

class FocusItem(BaseModel):
    label: str
    aliases: List[str] = []


class FocusRequest(BaseModel):
    transcript: Dict[str, Any]
    # Each item is a focus label plus optional reviewer-typed aliases (no LLM).
    focus_terms: List[FocusItem]
    threshold: Optional[float] = None
    top_k: Optional[int] = None
    # Auto query expansion from the transcript's own vocabulary (default on).
    auto_expand: Optional[bool] = None


# Default semantic gate. Pilot-tuned on case447: with alias-expanded queries
# relevant segments sit ~0.33–0.43 and unrelated ones ~0.10, so 0.30 separates
# cleanly. It is an engineering default, not a principled value (design v2 §3.1).
DEFAULT_FOCUS_THRESHOLD = 0.30
DEFAULT_FOCUS_TOP_K = 8

# ----- 2b "AI" mode: local-LLM retrieval (inference only, nothing leaves box) -
# A local Ollama model reads the whole transcript in context. Model + URL are
# env-overridable; the cache freezes judgments for the user study.
FOCUS_LLM_MODEL = os.environ.get("FOCUS_LLM_MODEL", "qwen2.5:7b-instruct")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_FOCUS_LLM_THRESHOLD = 0.5
FOCUS_LLM_CACHE_DIR = Path(__file__).resolve().parent / ".focus_cache"
# Long-transcript chapter outline (same local LLM); per-window cache freezes it.
OUTLINE_CACHE_DIR = Path(__file__).resolve().parent / ".outline_cache"
# Sentence-importance triage (sentence build); per-window cache, same freezing idea.
TRIAGE_CACHE_DIR = Path(__file__).resolve().parent / ".triage_cache"
# Contradiction check + event timeline (feedback-round builds); same cache scheme.
ANOMALY_CACHE_DIR = Path(__file__).resolve().parent / ".anomaly_cache"
TIMELINE_CACHE_DIR = Path(__file__).resolve().parent / ".timeline_cache"


# Semantic (encoder) leg of /focus. Set FOCUS_SEMANTIC=off on a low-memory
# machine to fall back to exact, alias and pattern matching.
def _focus_semantic_off() -> bool:
    explicit = os.environ.get("FOCUS_SEMANTIC", "").lower()
    return explicit == "off"


def _focus_encoder() -> Optional[Any]:
    """Return the local encoder, or None when semantic search is disabled."""
    return None if _focus_semantic_off() else get_encoder()


@app.post("/focus")
def focus(req: FocusRequest, model_name: Optional[str] = None) -> Dict[str, Any]:
    """Retrieve top-K evidence snippets for the reviewer's focus terms.

    Reuses the same frozen encoder as /predict. Does NOT mutate the transcript's
    2a scores — it returns overlay data (with each hit's original combined_risk)
    so the front-end can apply a traceable HIGH upgrade and reset it on demand.
    """
    transcript = req.transcript
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")

    encoder = _focus_encoder()
    default_threshold = float(
        os.environ.get("FOCUS_THRESHOLD", str(DEFAULT_FOCUS_THRESHOLD))
    )
    expand_threshold = float(os.environ.get("FOCUS_EXPAND_THRESHOLD", "0.55"))
    return focus_mod.run_focus(
        transcript,
        [item.model_dump() for item in req.focus_terms],
        encoder=encoder,
        pick_model=pick_model,
        clean_for_model=clean_for_model,
        threshold=req.threshold if req.threshold is not None else default_threshold,
        top_k=req.top_k if req.top_k is not None else DEFAULT_FOCUS_TOP_K,
        model_name=model_name,
        auto_expand=req.auto_expand if req.auto_expand is not None else True,
        expand_threshold=expand_threshold,
    )


class FocusLlmRequest(BaseModel):
    transcript: Dict[str, Any]
    # Each line is one free-text query: a bare keyword or a plain-English intent.
    queries: List[str]
    threshold: Optional[float] = None
    top_k: Optional[int] = None
    model: Optional[str] = None


@app.post("/focus_llm")
def focus_llm(req: FocusLlmRequest) -> Dict[str, Any]:
    """AI mode: a LOCAL LLM reads the whole transcript and returns the segments
    genuinely about each query (resolving pronouns / earlier mentions that the
    lexical path can't). Same overlay contract as /focus; trains nothing and
    nothing leaves the machine.
    """
    transcript = req.transcript
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")

    try:
        return focus_llm_mod.run_focus_llm(
            transcript,
            req.queries,
            pick_model=pick_model,
            clean_for_model=clean_for_model,
            model=req.model or FOCUS_LLM_MODEL,
            ollama_url=OLLAMA_URL,
            threshold=req.threshold if req.threshold is not None else DEFAULT_FOCUS_LLM_THRESHOLD,
            top_k=req.top_k if req.top_k is not None else DEFAULT_FOCUS_TOP_K,
            cache_dir=FOCUS_LLM_CACHE_DIR,
        )
    except focus_llm_mod.OllamaError as e:
        # Surface the actionable message verbatim through the FE's error banner.
        raise HTTPException(status_code=503, detail=str(e))


class ChatTurn(BaseModel):
    role: str  # "user" | "assistant" — validated in the handler
    content: str


class ChatRequest(BaseModel):
    transcript: Dict[str, Any]
    # Conversation oldest -> newest; the LAST entry must be the new user turn.
    messages: List[ChatTurn]
    model: Optional[str] = None


@app.post("/chat")
def chat(req: ChatRequest, model_name: Optional[str] = None) -> Dict[str, Any]:
    """AI assistant over the loaded transcript (full/police build convenience).

    The same LOCAL LLM as /focus_llm answers multi-turn questions grounded in
    segment citations that are validated server-side (unknown ids dropped,
    quotes checked). Ephemeral by design: no cache, nothing stored, nothing
    leaves the machine.
    """
    transcript = req.transcript
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")
    if not req.messages or req.messages[-1].role != "user":
        raise HTTPException(status_code=400, detail="messages[] must end with a user turn.")
    if any(m.role not in ("user", "assistant") for m in req.messages):
        raise HTTPException(status_code=400, detail="messages[].role must be user|assistant.")

    try:
        return chat_mod.run_chat(
            transcript,
            [{"role": m.role, "content": m.content} for m in req.messages],
            pick_model=lambda seg, _req: pick_model(seg, model_name),
            model=req.model or FOCUS_LLM_MODEL,
            ollama_url=OLLAMA_URL,
        )
    except chat_mod.OllamaError as e:
        # Same actionable banner pattern as /focus_llm when Ollama is down.
        raise HTTPException(status_code=503, detail=str(e))


class OutlineRequest(BaseModel):
    transcript: Dict[str, Any]
    # Optional: segments per LLM window (map step). Falls back to the default.
    window: Optional[int] = None
    model: Optional[str] = None


@app.post("/outline")
def outline(req: OutlineRequest, model_name: Optional[str] = None) -> Dict[str, Any]:
    """Build a navigable chapter outline of a (possibly very long) transcript.

    The same LOCAL LLM as /focus_llm reads the transcript in windows (map-reduce)
    and DECIDES the chapter boundaries + titles. The transcript is not mutated —
    the result is navigation overlay data (each chapter carries a [start,end]
    time range). Per-window judgments are cached on disk so re-runs are instant
    and the outline can be frozen for the study.
    """
    transcript = req.transcript
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")

    try:
        return outline_mod.run_outline(
            transcript,
            pick_model=lambda seg, _req: pick_model(seg, model_name),
            model=req.model or FOCUS_LLM_MODEL,
            ollama_url=OLLAMA_URL,
            window=req.window,  # None -> outline.py sizes the map window dynamically
            cache_dir=OUTLINE_CACHE_DIR,
        )
    except outline_mod.OllamaError as e:
        # Same actionable banner as AI focus when Ollama is down / model missing.
        raise HTTPException(status_code=503, detail=str(e))


class TriageRequest(BaseModel):
    transcript: Dict[str, Any]
    model: Optional[str] = None


@app.post("/triage")
def triage(req: TriageRequest, model_name: Optional[str] = None) -> Dict[str, Any]:
    """Sentence-importance triage (the sentence-build interface variant).

    The same LOCAL LLM picks, per paragraph window (outline chapters), the
    sentences a reviewer should re-listen to first. Binary high/low overlay —
    the transcript is not mutated. Per-window judgments are disk-cached so
    re-runs are instant and results can be baked for a hosted demo.
    """
    transcript = req.transcript
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")

    try:
        return triage_mod.run_triage(
            transcript,
            pick_model=lambda seg, _req: pick_model(seg, model_name),
            model=req.model or FOCUS_LLM_MODEL,
            ollama_url=OLLAMA_URL,
            cache_dir=TRIAGE_CACHE_DIR,
        )
    except triage_mod.OllamaError as e:
        raise HTTPException(status_code=503, detail=str(e))


class AnomalyRequest(BaseModel):
    transcript: Dict[str, Any]
    model: Optional[str] = None


@app.post("/anomalies")
def anomalies(req: AnomalyRequest, model_name: Optional[str] = None) -> Dict[str, Any]:
    """Cross-sentence contradiction check (the anomaly interface variant).

    The same LOCAL LLM flags PAIRS of lines that appear to conflict (time /
    place / person / statement) so the reviewer can re-check them against the
    audio. Pointing overlay only — the transcript is not mutated, and "no
    conflicts" is a valid result. Windows are disk-cached like /triage.
    """
    transcript = req.transcript
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")

    try:
        return anomaly_mod.run_anomalies(
            transcript,
            pick_model=lambda seg, _req: pick_model(seg, model_name),
            model=req.model or FOCUS_LLM_MODEL,
            ollama_url=OLLAMA_URL,
            cache_dir=ANOMALY_CACHE_DIR,
        )
    except anomaly_mod.OllamaError as e:
        raise HTTPException(status_code=503, detail=str(e))


class TimelineRequest(BaseModel):
    transcript: Dict[str, Any]
    model: Optional[str] = None


@app.post("/timeline")
def timeline(req: TimelineRequest, model_name: Optional[str] = None) -> Dict[str, Any]:
    """Event-timeline extraction (the timeline interface variant).

    The same LOCAL LLM lists the concrete events described in the recording,
    each citing the segment it is stated in (+ any spoken time reference). The
    UI joins each event to its segment start for click-to-seek. Windows are
    disk-cached like /triage.
    """
    transcript = req.transcript
    if "segments" not in transcript or not isinstance(transcript["segments"], list):
        raise HTTPException(status_code=400, detail="transcript.segments[] missing.")

    try:
        return timeline_mod.run_timeline(
            transcript,
            pick_model=lambda seg, _req: pick_model(seg, model_name),
            model=req.model or FOCUS_LLM_MODEL,
            ollama_url=OLLAMA_URL,
            cache_dir=TIMELINE_CACHE_DIR,
        )
    except timeline_mod.OllamaError as e:
        raise HTTPException(status_code=503, detail=str(e))
