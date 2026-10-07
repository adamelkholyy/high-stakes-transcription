import type { AnomalyResult, Transcript } from '../types'
import { API_BASE } from './apiBase'
import { PredictError } from './predictApi'

// Same local FastAPI service as /predict and /triage. 127.0.0.1 (not
// "localhost") so an IPv6 ::1 squatter can't intercept it (see predictApi).
const ANOMALY_URL = `${API_BASE}/anomalies`

/**
 * Cross-sentence contradiction check (the anomaly build's paradigm): a LOCAL
 * LLM flags PAIRS of segments that appear to conflict (time / place / person /
 * statement) for a re-check against the audio. Pointing overlay only — the
 * transcript is NOT mutated, and an empty result is a valid answer. Windows
 * are cached on disk server-side, so a re-run on the same transcript returns
 * instantly. Ollama-down errors surface verbatim via PredictError.
 */
export async function runAnomalies(
  transcript: Transcript,
  modelName?: string,
): Promise<AnomalyResult> {
  const url = modelName
    ? `${ANOMALY_URL}?model_name=${encodeURIComponent(modelName)}`
    : ANOMALY_URL

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    })
  } catch (e) {
    throw new PredictError(
      `Could not reach the conflict-check service at ${API_BASE}. ` +
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
    throw new PredictError(`Conflict check failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as AnomalyResult
}
