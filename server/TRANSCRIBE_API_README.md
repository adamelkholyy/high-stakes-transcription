# Local transcription service (:8001)

This optional FastAPI service turns an audio file into the nested transcript
JSON consumed by the review interface. Processing stays on the local machine.

## Pipeline

1. **WhisperX** — transcription, word alignment, and speaker diarisation.
2. **Qwen3-ASR-1.7B** — a second full-audio hypothesis.
3. **Parakeet-CTC-1.1B** — a third full-audio hypothesis.
4. **Ollama selector** — local `qwen2.5:7b` merges the hypotheses and assigns
   one confidence score per sentence.
5. **Schema assembly** — sentences are aligned back to WhisperX word timings
   and grouped into diarised speaker segments.

There is no cloud-LLM path in this public artifact. Ollama must be running on
the same machine.

## Requirements

- Python 3.11 or newer.
- `ffmpeg` available on `PATH`.
- Ollama with `qwen2.5:7b` installed and running.
- A Hugging Face read token in `HF_TOKEN`. The token must have access to the
  gated pyannote diarisation models required by WhisperX.
- Substantial disk space and memory for the speech models. Qwen3-ASR can use
  roughly 15 GB in this setup; set `SKIP_QWEN3ASR=1` on a lower-memory machine.

Use a separate environment from the smaller `:8000` model service because the
ASR stack has its own PyTorch, WhisperX, and pyannote requirements:

```bash
python3.11 -m venv .venv-asr
source .venv-asr/bin/activate
pip install -r server/requirements-transcribe.txt
ollama pull qwen2.5:7b
```

Create a local, uncommitted `server/.env`:

```dotenv
HF_TOKEN=hf_your_read_token
# Optional on lower-memory machines:
SKIP_QWEN3ASR=1
```

The repository ignores `.env` files. Never commit a real token.

## Start the service

From the repository root:

```bash
source .venv-asr/bin/activate
ollama serve                         # separate terminal, if not already running
cd server
uvicorn transcribe_api:app --host 127.0.0.1 --port 8001
```

Model downloads and the first startup can take considerable time. Wait for the
`[transcribe_api] Ready` message before submitting audio.

To expose the Transcribe control in the frontend, set this in `.env.local`:

```dotenv
VITE_ASR_BASE=http://127.0.0.1:8001
VITE_ASR_ENABLED=true
```

## Endpoints

### `GET /health`

Returns service status, the models that loaded successfully, and the pipeline
name.

### `POST /transcribe`

Accepts multipart form field `audio`. Supported formats depend on ffmpeg and
include WAV, MP3, M4A, OGG, and FLAC. Optional `num_speakers=N` pins the number
of speakers for diarisation.

```bash
curl -X POST "http://127.0.0.1:8001/transcribe?num_speakers=2" \
  -F "audio=@/absolute/path/to/interview.wav" \
  -o transcript.json
```

The response has this high-level shape:

```jsonc
{
  "audioDuration": 50.3,
  "pipelineTranscript": "Merged transcript text...",
  "modelTranscripts": {
    "whisperx": "...",
    "qwen": "...",
    "parakeet": "..."
  },
  "segments": [
    {
      "id": 0,
      "speaker": "SPEAKER_00",
      "start": 1.3,
      "end": 6.0,
      "sentences": [
        {
          "idx": 1,
          "score": 4,
          "confidence": 0.8,
          "sentence": "...",
          "start": 1.3,
          "end": 6.0,
          "speaker": "SPEAKER_00"
        }
      ]
    }
  ]
}
```

`src/lib/asrAdapter.ts` converts this nested response into the flat transcript
shape rendered by the interface. Confidence is sentence-level; it is not a
calibrated per-word uncertainty score.

## Long recordings

For long files, avoid an HTTP client timeout and write the same pipeline output
directly to disk:

```bash
source .venv-asr/bin/activate
cd server
python transcribe_to_disk.py /absolute/path/to/audio.wav output.json 2
```

The final argument is the optional number of speakers. The selector processes
long hypotheses in bounded windows so they fit the local Ollama context.

## Troubleshooting

- `HF_TOKEN not found`: add the token to `server/.env` and restart.
- A pyannote access error: accept the relevant gated model terms on Hugging
  Face for the account that issued the token.
- Qwen model loading exhausts memory: restart with `SKIP_QWEN3ASR=1`.
- Ollama connection error: run `ollama serve` and confirm `qwen2.5:7b` exists.
- Browser CORS error: run the frontend on localhost or `127.0.0.1`; the service
  intentionally accepts only local development origins.
