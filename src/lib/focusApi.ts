import type {
  FocusItem,
  FocusResult,
  FocusSnippet,
  FocusTermResult,
  Transcript,
} from '../types'
import { API_BASE } from './apiBase'
import { PredictError } from './predictApi'

// Same local FastAPI service as /predict — 2b reuses 2a's encoder. 127.0.0.1
// (not "localhost") so an IPv6 ::1 squatter can't intercept it (see predictApi).
const FOCUS_URL = `${API_BASE}/focus`
const FOCUS_LLM_URL = `${API_BASE}/focus_llm`

/**
 * POST the transcript + focus items to the case-focus retrieval service and
 * get back ranked evidence snippets per term. The transcript's 2a scores are
 * NOT mutated server-side; the response is overlay data (each snippet carries
 * `original_combined_risk`) so the HIGH upgrade stays a traceable, reversible
 * front-end overlay.
 *
 * Only the focus labels/aliases ever reach the service — never anything the
 * transcript wouldn't already contain — and the service is local, so nothing
 * about the case leaves the machine.
 */
export async function runFocus(
  transcript: Transcript,
  focusItems: FocusItem[],
  modelName?: string,
): Promise<FocusResult> {
  const url = modelName
    ? `${FOCUS_URL}?model_name=${encodeURIComponent(modelName)}`
    : FOCUS_URL

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, focus_terms: focusItems }),
    })
  } catch (e) {
    throw new PredictError(
      `Could not reach the focus service at ${API_BASE}. ` +
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
    throw new PredictError(`Focus retrieval failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as FocusResult
}

/**
 * AI mode: a LOCAL LLM reads the whole transcript and returns the segments
 * about each free-text query (a bare keyword or a plain-English intent), in the
 * same FocusResult shape as runFocus. Nothing leaves the machine (local Ollama);
 * an Ollama-down / model-missing error surfaces verbatim via PredictError.
 */
export async function runFocusAi(
  transcript: Transcript,
  queries: string[],
): Promise<FocusResult> {
  let res: Response
  try {
    res = await fetch(FOCUS_LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, queries }),
    })
  } catch (e) {
    throw new PredictError(
      `Could not reach the focus service at ${API_BASE}. ` +
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
    throw new PredictError(`AI focus failed (HTTP ${res.status}). ${detail}`)
  }

  return (await res.json()) as FocusResult
}

/**
 * Merge a lexical FocusResult with an AI (LLM) FocusResult into one result for
 * the unified "Find" box. The two engines run on the SAME lines in the SAME
 * order (both split on /[\n;]+/), so terms are aligned by index; the lexical
 * label/auto-aliases are kept as the section header.
 *
 * Per term, snippets are unioned by segment_id:
 *  - a segment both engines found keeps its lexical match (exact/alias/…) but
 *    gains the LLM's `llm_reason` and the stronger of the two scores;
 *  - a segment only the LLM found (a context/pronoun hit the lexical path
 *    can't see) is added as a fresh `match_type: 'llm'` snippet.
 *
 * Pure function (no I/O) so it is trivially testable.
 */
export function mergeFocusResults(
  lexical: FocusResult,
  ai: FocusResult | null,
): FocusResult {
  if (!ai || ai.terms.length === 0) return lexical
  const merged: FocusTermResult[] = lexical.terms.map((lex, i) => {
    const aiTerm = ai.terms[i]
    if (!aiTerm) return lex
    const bySeg = new Map<number, FocusSnippet>()
    for (const s of lex.snippets) bySeg.set(s.segment_id, { ...s })
    for (const a of aiTerm.snippets) {
      const existing = bySeg.get(a.segment_id)
      if (existing) {
        existing.llm_reason = a.llm_reason ?? existing.llm_reason
        existing.llm_relevance_score = a.llm_relevance_score
        existing.focus_score = Math.max(existing.focus_score, a.focus_score)
      } else {
        bySeg.set(a.segment_id, { ...a, match_type: 'llm' })
      }
    }
    const snippets = [...bySeg.values()].sort(
      (x, y) => y.focus_score - x.focus_score,
    )
    return { ...lex, snippets }
  })
  // Extra AI terms (more lines than the lexical pass produced) — append as-is.
  for (let i = lexical.terms.length; i < ai.terms.length; i++) {
    merged.push(ai.terms[i])
  }
  return { terms: merged }
}

/**
 * Parse the AI-mode box: each non-empty line (or ;-separated chunk) is one
 * free-text query, kept verbatim (a keyword and an intent are treated alike).
 */
export function parseFocusQueries(raw: string): string[] {
  return raw
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Parse the reviewer's focus text box into structured focus items.
 * Syntax (lightweight, single box): items separated by newline or `;`;
 * each item is `label` or `label: alias1, alias2`.
 *   weapon: gun, knife
 *   silver hatchback
 *   Reece
 */
export function parseFocusInput(raw: string): FocusItem[] {
  const items: FocusItem[] = []
  for (const chunk of raw.split(/[\n;]+/)) {
    const trimmed = chunk.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) {
      items.push({ label: trimmed, aliases: [] })
    } else {
      const label = trimmed.slice(0, colon).trim()
      const aliases = trimmed
        .slice(colon + 1)
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
      if (label) items.push({ label, aliases })
    }
  }
  return items
}
