"""
transcribe_api.py

FastAPI service — Context V2 + WhisperX ensemble pipeline.

Pipeline:
  1. WhisperX  — transcription + word alignment + speaker diarisation
  2. Qwen      — full audio transcription
  3. Parakeet  — full audio transcription
  4. Selector  — Context V2 LLM selector → combined transcript + sentence confidences
  5. Schema    — assign sentences to speaker segments

Run:
    uvicorn transcribe_api:app --port 8001

Endpoints:
    POST /transcribe  — accepts multipart audio file, returns transcript JSON
    GET  /health      — returns service status
"""
from __future__ import annotations

# PyTorch 2.6 compatibility — patch before any imports
import torch
_orig_load = torch.load
def _safe_load(*args, **kwargs):
    kwargs.setdefault("weights_only", False)
    return _orig_load(*args, **kwargs)
torch.load = _safe_load

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import librosa
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from ollama import Client
from pydantic import BaseModel

load_dotenv()

from asr_models import Qwen3ASR, Parakeet
from whisperx_transcribe import run_whisperx
from chunked_selector import run_selector_chunked

OLLAMA_HOST    = "http://localhost:11434"
SELECTOR_MODEL = "qwen2.5:7b"
HF_TOKEN       = os.environ.get("HF_TOKEN", "")

# The public artifact is local-only: transcript selection always runs through
# the Ollama instance on this machine. No cloud LLM provider is supported here.
print(f"[transcribe_api] Selector LLM: Ollama {SELECTOR_MODEL}")

# ── Selector prompt ────────────────────────────────────────────────────────────

SELECTOR_PROMPT = """You are a transcript editor for Scottish English police interview audio.

Three ASR models transcribed the same audio. Your job is to produce the single most accurate transcript by choosing the best words from the three versions.

TRANSCRIPT A (whisper — most reliable, use as your base):
{whisper}

TRANSCRIPT B (qwen):
{qwen}

TRANSCRIPT C (parakeet):
{parakeet}

SELECTION RULE:
Go word by word through Transcript A. Keep each word from A unless both B and C agree on a different word — in that case use the word B and C agree on.

RELIABILITY HINTS:
- For negation words, prefer qwen if it disagrees with the others.
- For Scottish dialect words, prefer qwen if it disagrees with the others.

OUTPUT RULES:
- Output only the final transcript text — no labels, no notes, no explanations.
- Do not write anything in parentheses.
- Do not mention which model you chose or why.
- The output is what a human reviewer will read as the final transcript.

After the transcript, rate each sentence 1-5 for confidence:
5 = all models agreed
4 = minor differences
3 = some disagreement
2 = significant disagreement  
1 = models strongly disagreed

Return ONLY this format:
TRANSCRIPT:
<transcript here — with proper punctuation, sentences ending in . or ? or 
CONFIDENCE:
1 | <score> | <sentence 1 — must match exactly one sentence from the transcript above>
2 | <score> | <sentence 2 — must match exactly one sentence from the transcript above>
...

IMPORTANT: The CONFIDENCE section must have exactly one line per sentence. 
A sentence ends at a period, question mark, or exclamation mark.
Never put multiple sentences on one CONFIDENCE line.
Never put the whole transcript on one CONFIDENCE line."""


def parse_selector_response(raw: str):
    transcript           = raw
    sentence_confidences = []

    if "TRANSCRIPT:" in raw and "CONFIDENCE:" in raw:
        parts           = raw.split("CONFIDENCE:")
        transcript      = parts[0].replace("TRANSCRIPT:", "").strip()
        confidence_part = parts[1].strip() if len(parts) > 1 else ""

        sent_pos = 0
        for line in confidence_part.split("\n"):
            line = line.strip()
            if not line:
                continue
            match = re.match(r"^(\d+)\s*\|\s*([1-5])\s*\|\s*(.+)$", line)
            if match:
                sent_pos += 1
                sentence_confidences.append({
                    "idx":        sent_pos,
                    "score":      int(match.group(2)),
                    "confidence": int(match.group(2)) / 5.0,
                    "sentence":   match.group(3).strip(),
                })
    elif "TRANSCRIPT:" in raw:
        transcript = raw.replace("TRANSCRIPT:", "").strip()

    return transcript, sentence_confidences


def run_selector(client, whisper_hyp, qwen_hyp, parakeet_hyp):
    try:
        prompt = SELECTOR_PROMPT.format(
            whisper=whisper_hyp, qwen=qwen_hyp, parakeet=parakeet_hyp,
        )
        response = client.chat(
            model=SELECTOR_MODEL,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": 0, "num_ctx": 4096},
        )
        return parse_selector_response(response.message.content.strip())
    except Exception as e:
        print(f"  ERROR (selector): {e}")
        return whisper_hyp, []


# ── Sentence → speaker assignment ──────────────────────────────────────────────

import difflib
import string
from typing import Dict, List


def _normalise_word(word: str) -> str:
    return word.lower().strip().strip(string.punctuation)


def _tokenise(text: str) -> List[str]:
    return [_normalise_word(w) for w in text.split() if _normalise_word(w)]


def _find_best_word_span(sentence: str, word_segments: List[Dict], search_start: int = 0):
    """
    Find the best matching span of WhisperX words for a selector sentence.

    This uses WhisperX word order as the timing anchor.
    It returns:
        start_idx, end_idx, match_score
    """
    sent_tokens = _tokenise(sentence)
    if not sent_tokens:
        return None, None, 0.0

    wx_tokens = [_normalise_word(w.get("word", "")) for w in word_segments]
    wx_tokens = [w for w in wx_tokens if w]

    if not wx_tokens:
        return None, None, 0.0

    sent_len = len(sent_tokens)

    best_start = None
    best_end = None
    best_score = 0.0

    # Search around the expected forward position.
    # This prevents sentence 5 from matching something in sentence 1.
    max_window_extra = 8
    min_len = max(1, sent_len - max_window_extra)
    max_len = sent_len + max_window_extra

    for start in range(search_start, len(wx_tokens)):
        for span_len in range(min_len, max_len + 1):
            end = start + span_len
            if end > len(wx_tokens):
                continue

            candidate = wx_tokens[start:end]
            score = difflib.SequenceMatcher(None, sent_tokens, candidate).ratio()

            if score > best_score:
                best_score = score
                best_start = start
                best_end = end

        # small optimisation: once we have a strong match, stop searching too far ahead
        if best_score >= 0.88 and start > search_start + sent_len + 5:
            break

    return best_start, best_end, best_score


def _speaker_from_words(words: List[Dict]) -> Dict:
    """
    Assign speaker by majority word ownership.
    Also returns a simple speaker confidence.
    """
    votes: Dict[str, int] = {}

    for w in words:
        speaker = w.get("speaker") or "UNKNOWN"
        votes[speaker] = votes.get(speaker, 0) + 1

    if not votes:
        return {
            "speaker": "UNKNOWN",
            "speaker_confidence": 0.0,
            "speaker_uncertain": True,
        }

    best_speaker = max(votes, key=votes.get)
    total = sum(votes.values())
    speaker_confidence = votes[best_speaker] / max(1, total)

    return {
        "speaker": best_speaker,
        "speaker_confidence": round(speaker_confidence, 3),
        "speaker_uncertain": speaker_confidence < 0.6,
    }


def assign_sentences_to_speakers(
    sentence_confidences: List[Dict],
    word_segments: List[Dict],
    speaker_segments: List[Dict],
    pipeline_transcript: str,
    audio_duration: float,
) -> List[Dict]:
    """
    Assign each selector sentence to timestamps and speakers using WhisperX words.

    Important:
    - Sentence confidence comes from the selector.
    - Timestamps and speakers come from WhisperX word alignment.
    - Speaker grouping is only for display.
    """

    if not sentence_confidences:
        return []

    if not word_segments:
        return [{
            "id": 0,
            "speaker": "UNKNOWN",
            "start": 0.0,
            "end": round(audio_duration, 3),
            "sentences": sentence_confidences,
        }]

    sentence_units = []
    search_cursor = 0

    for sc in sentence_confidences:
        sentence_text = sc.get("sentence", "").strip()

        start_idx, end_idx, match_score = _find_best_word_span(
            sentence_text,
            word_segments,
            search_start=search_cursor,
        )

        if start_idx is None or end_idx is None:
            sentence_units.append({
                **sc,
                "start": None,
                "end": None,
                "speaker": "UNKNOWN",
                "speaker_confidence": 0.0,
                "speaker_uncertain": True,
                "alignment_score": 0.0,
                "alignment_uncertain": True,
            })
            continue

        matched_words = word_segments[start_idx:end_idx]

        valid_starts = [w.get("start") for w in matched_words if w.get("start") is not None]
        valid_ends = [w.get("end") for w in matched_words if w.get("end") is not None]

        sent_start = min(valid_starts) if valid_starts else None
        sent_end = max(valid_ends) if valid_ends else None

        speaker_info = _speaker_from_words(matched_words)

        sentence_units.append({
            **sc,
            "start": round(sent_start, 3) if sent_start is not None else None,
            "end": round(sent_end, 3) if sent_end is not None else None,
            "speaker": speaker_info["speaker"],
            "speaker_confidence": speaker_info["speaker_confidence"],
            "speaker_uncertain": speaker_info["speaker_uncertain"],
            "alignment_score": round(match_score, 3),
            "alignment_uncertain": match_score < 0.65,
        })

        # Move forward so the next sentence does not match old words.
        search_cursor = max(search_cursor, end_idx)

    # Group consecutive sentence units by speaker for frontend display.
    grouped_segments = []
    current = None

    for sent in sentence_units:
        speaker = sent.get("speaker", "UNKNOWN")

        if current is None or speaker != current["speaker"]:
            if current is not None:
                grouped_segments.append(current)

            current = {
                "id": len(grouped_segments),
                "speaker": speaker,
                "start": sent.get("start"),
                "end": sent.get("end"),
                "sentences": [sent],
            }
        else:
            current["sentences"].append(sent)
            if sent.get("end") is not None:
                current["end"] = sent.get("end")

    if current is not None:
        grouped_segments.append(current)

    # Clean segment-level start/end values.
    for seg in grouped_segments:
        starts = [s.get("start") for s in seg["sentences"] if s.get("start") is not None]
        ends = [s.get("end") for s in seg["sentences"] if s.get("end") is not None]

        seg["start"] = round(min(starts), 3) if starts else None
        seg["end"] = round(max(ends), 3) if ends else None

    return grouped_segments


# ── Model loading ──────────────────────────────────────────────────────────────

def _try_load(name: str, factory) -> Any:
    try:
        print(f"  Loading {name}...")
        model = factory()
        model.load()
        print(f"  [ok] {name} loaded.")
        return model
    except Exception as e:
        print(f"  [skip] {name} failed: {type(e).__name__}: {e}")
        return None


print("[transcribe_api] Loading ASR models...")
# SKIP_QWEN3ASR=1 skips loading Qwen3-ASR entirely (it needs ~15GB and OOMs /
# thrashes swap on low-RAM machines). The selector already falls back to the
# WhisperX hypothesis for the qwen slot, so the pipeline still runs end-to-end.
if os.environ.get("SKIP_QWEN3ASR"):
    print("  [skip] Qwen3ASR disabled via SKIP_QWEN3ASR")
    qwen_model = None
else:
    qwen_model = _try_load("Qwen3ASR",  Qwen3ASR)
parakeet_model = _try_load("Parakeet",  Parakeet)
MODELS_LOADED  = [m for m, obj in [("qwen", qwen_model), ("parakeet", parakeet_model)] if obj is not None]
print(f"[transcribe_api] Ready. Loaded: {MODELS_LOADED}")


# ── FastAPI app ────────────────────────────────────────────────────────────────

app = FastAPI(title="asr-transcription-api", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


class Health(BaseModel):
    status:        str
    models_loaded: List[str]
    pipeline:      str


@app.get("/health", response_model=Health)
def health() -> Health:
    return Health(
        status="ok",
        models_loaded=["whisperx"] + MODELS_LOADED,
        pipeline="Context V2 + WhisperX ensemble",
    )


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    num_speakers: Optional[int] = None,
) -> Dict[str, Any]:
    contents = await audio.read()
    suffix   = Path(audio.filename).suffix if audio.filename else ".wav"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        audio_array, sr = librosa.load(tmp_path, sr=None, mono=True)
    except Exception as e:
        os.unlink(tmp_path)
        raise HTTPException(status_code=400, detail=f"Could not load audio: {e}")

    audio_duration = len(audio_array) / sr
    print(f"[transcribe] Audio: {audio_duration:.1f}s at {sr}Hz")

    client = Client(host=OLLAMA_HOST)

    try:
        # Step 1: WhisperX
        print("[transcribe] Running WhisperX...")
        wx_result        = run_whisperx(audio_path=tmp_path, hf_token=HF_TOKEN, language="en", num_speakers=num_speakers)
        wx_transcript    = wx_result["full_text"]
        word_segments    = wx_result["word_segments"]
        speaker_segments = wx_result["speaker_segments"]
        print(f"[transcribe] WhisperX complete ({len(wx_transcript)} characters)")

        # resample for Qwen + Parakeet
        audio_16k = librosa.resample(audio_array, orig_sr=sr, target_sr=16000) \
                    if sr != 16000 else audio_array.copy()
        audio_16k = audio_16k.astype(np.float32)

        # Step 2: Qwen
        qwen_hyp = ""
        if qwen_model:
            print("[transcribe] Running Qwen...")
            try:
                qwen_hyp = qwen_model.transcribe(audio_16k, 16000).text
                print(f"[transcribe] Qwen complete ({len(qwen_hyp)} characters)")
            except Exception as e:
                print(f"[transcribe] Qwen error: {e}")

        # Step 3: Parakeet
        parakeet_hyp = ""
        if parakeet_model:
            print("[transcribe] Running Parakeet...")
            try:
                parakeet_hyp = parakeet_model.transcribe(audio_array, sr).text
                print(f"[transcribe] Parakeet complete ({len(parakeet_hyp)} characters)")
            except Exception as e:
                print(f"[transcribe] Parakeet error: {e}")

        # Step 4: Context V2 selector — windowed so long (~27-min) transcripts
        # do not overflow Ollama's num_ctx=4096. Short clips use one chunk.
        print("[transcribe] Running Context V2 selector (chunked)...")
        pipeline_transcript, sentence_confidences = run_selector_chunked(
            run_selector,
            client,
            wx_transcript,
            qwen_hyp,
            parakeet_hyp,
        )
        print(f"[transcribe] Pipeline complete ({len(pipeline_transcript)} characters)")
        print(f"[transcribe] {len(sentence_confidences)} sentence confidence scores")

        # Step 5: Assign sentences to speaker segments
        segments = assign_sentences_to_speakers(
            sentence_confidences=sentence_confidences,
            word_segments=word_segments,
            speaker_segments=speaker_segments,
            pipeline_transcript=pipeline_transcript,
            audio_duration=audio_duration,
        )

        return {
            "audioDuration":       round(audio_duration, 3),
            "pipelineTranscript":  pipeline_transcript,
            "modelTranscripts": {
                "whisperx":  wx_transcript,
                "qwen":      qwen_hyp,
                "parakeet":  parakeet_hyp,
            },
            "segments": segments,
        }

    except Exception as e:
        print(f"[transcribe] ERROR: {e}")
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
