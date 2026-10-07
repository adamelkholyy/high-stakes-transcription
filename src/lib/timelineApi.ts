import type { TimelineResult, Transcript } from '../types'
import { API_BASE } from './apiBase'
import { PredictError } from './predictApi'

// Same local FastAPI service as /predict and /triage. 127.0.0.1 (not
// "localhost") so an IPv6 ::1 squatter can't intercept it (see predictApi).
const TIMELINE_URL = `${API_BASE}/timeline`

/**
 * Event-timeline extraction (the timeline build's paradigm): a LOCAL LLM lists
 * the concrete events described in the recording, each citing the segment it
 * is stated in (+ any spoken time reference). The UI joins each event to its
 * segment start for click-to-seek — a navigation overlay; the transcript is
 * NOT mutated. Windows are cached on disk server-side, so a re-run on the same
 * transcript returns instantly. Ollama-down errors surface via PredictError.
 */
export async function runTimeline(
  transcript: Transcript,
  modelName?: string,
): Promise<TimelineResult> {
  const url = modelName
    ? `${TIMELINE_URL}?model_name=${encodeURIComponent(modelName)}`
    : TIMELINE_URL

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    })
  } catch (e) {
    throw new PredictError(
      `Could not reach the timeline service at ${API_BASE}. ` +
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
    throw new PredictError(`Timeline failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as TimelineResult
}
