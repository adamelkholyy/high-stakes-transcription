import type { OutlineResult, Transcript } from '../types'
import { API_BASE } from './apiBase'
import { PredictError } from './predictApi'

// Same local FastAPI service as /predict and /focus. 127.0.0.1 (not "localhost")
// so an IPv6 ::1 squatter can't intercept it (see predictApi).
const OUTLINE_URL = `${API_BASE}/outline`

/**
 * Build a navigable chapter outline of a (possibly very long) transcript. A
 * LOCAL LLM reads the transcript in windows (map-reduce, server-side) and
 * decides the chapter boundaries + titles. Per-window judgments are cached on
 * disk server-side, so a second call on the same transcript returns instantly.
 *
 * The transcript is NOT mutated — the result is navigation overlay data (each
 * chapter carries a [segment_start, segment_end] time range). An Ollama-down /
 * model-missing error surfaces verbatim via PredictError, exactly like AI focus.
 */
export async function runOutline(
  transcript: Transcript,
  modelName?: string,
): Promise<OutlineResult> {
  const url = modelName
    ? `${OUTLINE_URL}?model_name=${encodeURIComponent(modelName)}`
    : OUTLINE_URL

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    })
  } catch (e) {
    throw new PredictError(
      `Could not reach the outline service at ${API_BASE}. ` +
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
    throw new PredictError(`Outline failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as OutlineResult
}
