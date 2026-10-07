import type { Transcript, TriageResult } from '../types'
import { API_BASE } from './apiBase'
import { PredictError } from './predictApi'

// Same local FastAPI service as /predict and /outline. 127.0.0.1 (not
// "localhost") so an IPv6 ::1 squatter can't intercept it (see predictApi).
const TRIAGE_URL = `${API_BASE}/triage`

/**
 * Sentence-importance triage (the sentence build's paradigm): a LOCAL LLM
 * picks, per paragraph window, the sentences a reviewer should re-listen to
 * first. Binary high/low overlay — the transcript is NOT mutated. Per-window
 * judgments are cached on disk server-side, so a re-run on the same transcript
 * returns instantly. Ollama-down / model-missing errors surface verbatim via
 * PredictError, exactly like AI focus and the outline.
 */
export async function runTriage(
  transcript: Transcript,
  modelName?: string,
): Promise<TriageResult> {
  const url = modelName
    ? `${TRIAGE_URL}?model_name=${encodeURIComponent(modelName)}`
    : TRIAGE_URL

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    })
  } catch (e) {
    throw new PredictError(
      `Could not reach the triage service at ${API_BASE}. ` +
        'Start it with:  uvicorn serve_model:app --port 8000  (run from server/)',
      e,
    )
  }

  if (!res.ok) {
    let detail = ''
    try {
      detail = (await res.json())?.detail ?? ''
    } catch {
      /* ignore */
    }
    throw new PredictError(`Sentence triage failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as TriageResult
}
