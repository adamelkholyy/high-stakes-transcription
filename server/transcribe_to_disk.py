# Run the ASR ensemble on ONE wav and write the raw pipeline JSON to disk.
# Standalone (no HTTP / no client timeout) so a multi-hour CPU run can't be lost
# to a dropped request. Reuses transcribe_api's already-loaded models + steps, so
# the output is byte-identical to what POST /transcribe would return.
#
#   python transcribe_to_disk.py <wav> <out.json> [num_speakers]
import sys
import json
import time

import numpy as np
import librosa
from ollama import Client

import transcribe_api as T  # module-level import loads Qwen3ASR + Parakeet
from chunked_selector import run_selector_chunked

wav_path = sys.argv[1]
out_path = sys.argv[2]
num_speakers = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None

t0 = time.time()
print(f"[disk] loading {wav_path}", flush=True)
audio_array, sr = librosa.load(wav_path, sr=None, mono=True)
dur = len(audio_array) / sr
print(f"[disk] audio {dur:.1f}s @ {sr}Hz", flush=True)

client = Client(host=T.OLLAMA_HOST)

print("[disk] WhisperX...", flush=True)
wx = T.run_whisperx(audio_path=wav_path, hf_token=T.HF_TOKEN, language="en", num_speakers=num_speakers)
wx_transcript = wx["full_text"]
print(
    f"[disk] WhisperX done ({time.time()-t0:.0f}s, {len(wx_transcript)} characters)",
    flush=True,
)

audio_16k = (
    librosa.resample(audio_array, orig_sr=sr, target_sr=16000) if sr != 16000 else audio_array.copy()
).astype(np.float32)

qwen_hyp = ""
if T.qwen_model:
    print("[disk] Qwen...", flush=True)
    try:
        qwen_hyp = T.qwen_model.transcribe(audio_16k, 16000).text
        print(f"[disk] Qwen done ({time.time()-t0:.0f}s)", flush=True)
    except Exception as e:
        print(f"[disk] Qwen error: {e}", flush=True)

parakeet_hyp = ""
if T.parakeet_model:
    print("[disk] Parakeet...", flush=True)
    try:
        parakeet_hyp = T.parakeet_model.transcribe(audio_array, sr).text
        print(f"[disk] Parakeet done ({time.time()-t0:.0f}s)", flush=True)
    except Exception as e:
        print(f"[disk] Parakeet error: {e}", flush=True)

print("[disk] Context V2 selector (chunked)...", flush=True)
pipeline_transcript, sentence_confidences = run_selector_chunked(
    T.run_selector,
    client,
    wx_transcript,
    qwen_hyp,
    parakeet_hyp,
)
print(f"[disk] selector done ({time.time()-t0:.0f}s): {len(sentence_confidences)} sentence scores", flush=True)

segments = T.assign_sentences_to_speakers(
    sentence_confidences=sentence_confidences,
    word_segments=wx["word_segments"],
    speaker_segments=wx["speaker_segments"],
    pipeline_transcript=pipeline_transcript,
    audio_duration=dur,
)

result = {
    "audioDuration": round(dur, 3),
    "pipelineTranscript": pipeline_transcript,
    "modelTranscripts": {
        "whisperx": wx_transcript,
        "qwen": qwen_hyp,
        "parakeet": parakeet_hyp,
    },
    "segments": segments,
}
with open(out_path, "w") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"[disk] WROTE {out_path} · {len(segments)} segments · total {time.time()-t0:.0f}s", flush=True)
