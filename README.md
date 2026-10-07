# MLMI Transcript Review

A local-first transcript-review research prototype for inspecting imperfect
speech recognition in high-stakes interviews. The interface combines
word-level risk marks, sentence-confidence tints, audio-linked editing, and a
locally run AI toolkit for evidence finding, outline generation, grounded
questions, conflict checking, and timeline extraction.

This repository is the reproducible software artifact for the dissertation
*AI Transcription for High-Stakes Settings*. It contains the review interface,
the local model service, and a bundled synthetic demonstration case. It is a
prototype-only handoff: participant tracking, behavioural event logging,
study launchers, response collection, and remote upload code are not included.
The questionnaires are preserved as static reference documents under
`research/questionnaires/`.

## Highlights

- Word and sentence uncertainty views with reversible display controls.
- Audio-linked word correction and sentence rewriting.
- Local Ollama tools: Find, Assistant, Conflicts, Timeline, and Outline.
- Local MiniLM importance classification and semantic retrieval.
- Five interface variants plus direct full and sentence-focused entry points.
- Reviewer audit history and transcript/audit exports.
- Transcript JSON import and an optional independent local ASR endpoint.

## Local architecture

```text
Browser (Vite + React)
        |
        |-- http://127.0.0.1:8000 ---> FastAPI model service
        |                                |-- MiniLM + importance classifier
        |                                `-- Ollama at http://127.0.0.1:11434
        |
        `-- http://127.0.0.1:8001 ---> FastAPI transcription service
                                         |-- WhisperX (align + diarise)
                                         |-- Qwen3-ASR / Parakeet
                                         `-- LLM selector -> merged transcript
```

Both services are optional to each other. The review interface needs only the
model service on :8000; the transcription service on :8001 turns audio into the
transcript JSON the interface reads, and can be skipped if you bring your own
transcripts.

The default configuration is local-only. Reviewer edits and verification
actions stay in the current browser session and can be exported deliberately
from the Review panel; they are not behavioural research telemetry.

## Requirements

- Node.js 18 or newer
- Python 3.11 or newer
- [Ollama](https://ollama.com/)
- `ffmpeg` for the optional transcription service

## Run locally



Install and start the local language model:

```bash
ollama pull qwen2.5:7b-instruct
ollama serve
```

In another terminal, start the model service in its own environment:

```bash
source .venv-model/bin/activate
cd server
uvicorn serve_model:app --host 127.0.0.1 --port 8000
```

Then start the interface from the repository root:

```bash
cp .env.example .env.local
npm ci
npm run dev
```

Open the local URL printed by Vite. The first semantic request may download the
MiniLM weights; inference then runs locally.

## Interface modes

Set `VITE_APP_MODE` in `.env.local`:

| Value | Entry point |
| --- | --- |
| omitted | Five-version launcher |
| `complete` | Handoff default: all highlighting and AI tools |
| `full` | Core workspace with Find, Assistant, and Outline |
| `sentence` | Sentence-confidence interface |

Audio-to-transcript processing is optional and disabled in `.env.example`.
It uses a separate Python environment because WhisperX and pyannote have a much
heavier dependency stack than the model service. A Hugging Face read token with
access to the required gated diarisation models must be saved as `HF_TOKEN` in
an uncommitted `server/.env` file.

Enable transcription once the service is running on port 8001:

```bash
python3.11 -m venv .venv-asr
source .venv-asr/bin/activate
pip install -r server/requirements-transcribe.txt
ollama pull qwen2.5:7b
cd server && uvicorn transcribe_api:app --port 8001
```

It downloads several speech models on first run and needs substantial memory;
set `SKIP_QWEN3ASR=1` to leave the heaviest one out. The selector is local-only
and uses Ollama; transcript content is not sent to a cloud LLM.
`server/TRANSCRIBE_API_README.md` covers setup and endpoints, and
`server/transcribe_to_disk.py` runs the same pipeline from the command line for
long recordings. Transcript JSON import works without any of this.

## Verification

```bash
npx tsc --noEmit
npm run build
python3.11 -m compileall -q server
```

## Repository layout

- `src/core/ReviewWorkspace.tsx` — shared review workspace.
- `src/core/config.ts` — feature flags for every interface variant.
- `research/questionnaires/` — static questionnaire archive (not connected to the app).
- `server/serve_model.py` — local FastAPI model service.
- `server/focus_llm.py` — Ollama-backed transcript retrieval.
- `scripts/` — stimulus preparation, comparison, and local scoring utilities.

## Data and research use

Do not commit participant exports, contact details, answer keys, local model
caches, or environment files. The existing `.gitignore` excludes the
corresponding working directories.

## Citation

Citation metadata is provided in [`CITATION.cff`](CITATION.cff).
Component-level contribution details are listed in [`AUTHORS.md`](AUTHORS.md).

## License

Code is released under the MIT License. The bundled demonstration case is
synthetic. Any audio or transcripts you add under `public/stimuli/` retain
their own original status.
