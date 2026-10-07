import type { Transcript } from '../types'
import { API_BASE } from './apiBase'

// Where the local FastAPI service lives. Vite proxying is intentionally NOT
// used so the dev/prod behaviour is identical. We use 127.0.0.1 (not
// "localhost") on purpose: uvicorn binds IPv4 127.0.0.1, but "localhost" can
// resolve to IPv6 ::1 first — if anything else is squatting ::1:8000 (e.g. a
// stray `python -m http.server 8000`), the browser would hit that instead.
const PREDICT_URL = `${API_BASE}/predict`

export class PredictError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'PredictError'
  }
}

/**
 * POST the transcript to the importance-classifier service and get back the
 * same structure with three extra per-word fields:
 *   - predicted_importance: 'high' | 'med' | 'low'
 *   - predicted_proba: { high, med, low }
 *   - combined_risk: 'high' | 'med' | 'low'
 * The upstream `risk` (uncertainty) field is preserved untouched.
 */
export async function predictRisks(
  transcript: Transcript,
  modelName?: string,
): Promise<Transcript> {
  const url = modelName
    ? `${PREDICT_URL}?model_name=${encodeURIComponent(modelName)}`
    : PREDICT_URL

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(transcript),
    })
  } catch (e) {
    throw new PredictError(
      `Could not reach the prediction service at ${API_BASE}. ` +
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
    throw new PredictError(`Prediction failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as Transcript
}
