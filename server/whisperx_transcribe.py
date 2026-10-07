"""
whisperx_transcribe.py
WhisperX-based transcription, alignment, and diarisation.
"""

import os
from typing import Optional, List, Dict
from dotenv import load_dotenv

load_dotenv()

import torch
_orig_load = torch.load
def _safe_load(*args, **kwargs):
    kwargs.setdefault("weights_only", False)
    return _orig_load(*args, **kwargs)
torch.load = _safe_load


def run_whisperx(
    audio_path:   str,
    hf_token:     Optional[str] = None,
    num_speakers: Optional[int] = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
    model_size:   str = "large-v3",
    language:     str = "en",
    device:       Optional[str] = None,
    batch_size:   int = 4,
    compute_type: str = "float32",
) -> Dict:
    import whisperx

    if hf_token is None:
        hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise ValueError("HF_TOKEN not found.")

    if device is None:
        if torch.cuda.is_available():
            device       = "cuda"
            compute_type = "float16"
        else:
            device       = "cpu"
            compute_type = "int8"
    print(f"  Device: {device} ({compute_type})")

    print(f"  Loading WhisperX model ({model_size})...")
    model  = whisperx.load_model(model_size, device=device, compute_type=compute_type, language=language)
    audio  = whisperx.load_audio(audio_path)
    result = model.transcribe(audio, batch_size=batch_size, language=language)
    print(f"  Transcribed {len(result['segments'])} segments")
    del model

    print(f"  Aligning words...")
    model_a, metadata = whisperx.load_align_model(language_code=language, device=device)
    result = whisperx.align(result["segments"], model_a, metadata, audio, device=device, return_char_alignments=False)
    print(f"  Aligned {len(result.get('word_segments', []))} words")
    del model_a

    print(f"  Running speaker diarisation...")
    try:
        from whisperx.diarize import DiarizationPipeline
    except ImportError:
        DiarizationPipeline = whisperx.DiarizationPipeline

    try:
        diarize_model = DiarizationPipeline(token=hf_token, device=device)
    except TypeError:
        diarize_model = DiarizationPipeline(use_auth_token=hf_token, device=device)

    diarize_kwargs = {}
    if num_speakers is not None:
        diarize_kwargs["num_speakers"] = num_speakers
    else:
        if min_speakers is not None: diarize_kwargs["min_speakers"] = min_speakers
        if max_speakers is not None: diarize_kwargs["max_speakers"] = max_speakers

    diarize_segments = diarize_model(audio, **diarize_kwargs)
    result           = whisperx.assign_word_speakers(diarize_segments, result)

    word_segments = []
    for seg in result.get("segments", []):
        speaker = seg.get("speaker", "UNKNOWN")
        for word_info in seg.get("words", []):
            word_segments.append({
                "word":    word_info.get("word", "").strip(),
                "start":   word_info.get("start"),
                "end":     word_info.get("end"),
                "speaker": speaker,
                "score":   word_info.get("score", 0.8),
            })

    speaker_segments = []
    current_speaker  = None
    current_words    = []
    current_start    = None

    for w in word_segments:
        if w["speaker"] != current_speaker:
            if current_words and current_speaker is not None:
                speaker_segments.append({
                    "speaker": current_speaker,
                    "start":   current_start,
                    "end":     current_words[-1].get("end"),
                    "text":    " ".join(x["word"] for x in current_words),
                })
            current_speaker = w["speaker"]
            current_words   = [w]
            current_start   = w.get("start")
        else:
            current_words.append(w)

    if current_words and current_speaker is not None:
        speaker_segments.append({
            "speaker": current_speaker,
            "start":   current_start,
            "end":     current_words[-1].get("end"),
            "text":    " ".join(x["word"] for x in current_words),
        })

    full_text = " ".join(seg.get("text", "") for seg in result.get("segments", [])).strip()

    print(f"  Found {len(set(w['speaker'] for w in word_segments if w.get('speaker')))} speakers")
    print(f"  {len(speaker_segments)} speaker segments")

    return {
        "word_segments":    word_segments,
        "speaker_segments": speaker_segments,
        "full_text":        full_text,
        "raw_result":       result,
    }
