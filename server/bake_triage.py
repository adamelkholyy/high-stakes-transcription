"""Bake the sentence-triage result for the bundled demo case.

The hosted sentence-build demo (Police Scotland feedback round) cannot reach a
127.0.0.1:8000 backend, so — same pattern as the study's frozen focus results —
this script runs the triage ONCE locally and writes it next to the bundled
transcript. The frontend uses the baked file whenever the bundled default case
is loaded; live /triage remains the path for uploaded/transcribed audio.

Deliberately does NOT import serve_model (that would load the 2a classifier
into memory just for two constants); env resolution is duplicated instead.

Usage (Ollama running):  cd server && python bake_triage.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from triage import run_triage

FOCUS_LLM_MODEL = os.environ.get("FOCUS_LLM_MODEL", "qwen2.5:7b-instruct")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
TRIAGE_CACHE_DIR = Path(__file__).resolve().parent / ".triage_cache"

ROOT = Path(__file__).resolve().parent.parent
TRANSCRIPT = ROOT / "src" / "data" / "defaultTranscript.json"
OUT = ROOT / "src" / "data" / "defaultTriage.json"


def main() -> None:
    transcript = json.loads(TRANSCRIPT.read_text())
    result = run_triage(
        transcript,
        # Bundled demo transcript carries a single model branch.
        pick_model=lambda seg, _req: next(iter(seg["words"])),
        model=FOCUS_LLM_MODEL,
        ollama_url=OLLAMA_URL,
        cache_dir=TRIAGE_CACHE_DIR,
    )
    OUT.write_text(json.dumps(result, indent=2) + "\n")
    high = sum(1 for s in result["segments"] if s["importance"] == "high")
    print(f"baked {OUT.relative_to(ROOT)}: {high}/{len(result['segments'])} high "
          f"({result['_windows']} windows, model {result['_model']})")


if __name__ == "__main__":
    main()
