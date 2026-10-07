import type { Risk, Segment, Transcript, Word } from '../types'

/**
 * Adapter for the teammate ASR pipeline output (backend_update branch):
 * a 3-model ensemble (WhisperX + qwen + parakeet) → WhisperX diarisation /
 * alignment → an LLM "selector" that merges them and rates each sentence's
 * cross-model agreement. Its JSON differs structurally from our `Transcript`:
 *   - sentences are NESTED inside speaker segments (we want flat segments),
 *   - text is a plain string (we want tokenised `words`),
 *   - the signal is `confidence` 0–1 (we want `paraRisk` high/med/low).
 *
 * `confidence` is a SENTENCE-level confidence: low = the models disagreed here
 * = the sentence is most likely mis-transcribed. That maps to the "Sentence
 * confidence" interface version (`paraRisk`). We read `confidence` (0–1) and
 * ignore `score` (1–5); if `confidence` later becomes a real continuous value
 * (today it is `score/5`) this still works — only the thresholds may need
 * recalibrating against a held-out development set.
 */

interface AsrSentence {
  confidence?: number
  score?: number // 1–5; deliberately unused (misaligned for now)
  sentence?: string
  start?: number
  end?: number
  speaker?: string
}
interface AsrSegment {
  id?: number
  speaker?: string
  start?: number
  end?: number
  sentences?: AsrSentence[]
}
interface AsrPipelineOutput {
  audioDuration?: number
  segments?: AsrSegment[]
}

// One stable model key for the merged transcript text. `availableModels` is
// derived from Object.keys(segment.words), so this key auto-selects and the
// text renders via segment.words[model]. The pipeline gives no word-level
// scores, so every word carries risk 'low'.
const MODEL_KEY = 'ASR ensemble'

// confidence → risk, INVERTED (low confidence = high risk = "check this").
// Placeholder thresholds — calibrate once confidence estimates are validated.
// With her discrete confidence = score/5: 1.0 → 'low' (no tint), 0.8 & 0.6 →
// 'med' (amber), 0.4 & 0.2 → 'high' (red). Only near-total agreement is left
// unmarked so borderline sentences still surface.
const CONF_LOW_RISK = 0.9 // >= → 'low' (only ~total agreement is left unmarked)
const CONF_MED_RISK = 0.5 // >= → 'med'; below → 'high'

export function confidenceToRisk(c: number | undefined | null): Risk {
  if (typeof c !== 'number' || !Number.isFinite(c)) return 'low'
  if (c >= CONF_LOW_RISK) return 'low'
  if (c >= CONF_MED_RISK) return 'med'
  return 'high'
}

/** True for the teammate's nested-sentence shape (which no valid `Transcript`
 *  has), so the adapter only fires on her format and normal transcripts pass
 *  straight through. */
export function isAsrPipelineOutput(json: unknown): json is AsrPipelineOutput {
  if (!json || typeof json !== 'object') return false
  const segs = (json as AsrPipelineOutput).segments
  return Array.isArray(segs) && segs.length > 0 && segs.some((s) => Array.isArray(s?.sentences))
}

/** Flatten her `segments[].sentences[]` into our flat `Transcript.segments[]`,
 *  one segment per sentence. Enforces the invariants `validateTranscript`
 *  requires (unique ids, non-empty speaker, 0 ≤ start < end ≤ audioDuration). */
export function adaptAsrPipelineOutput(json: AsrPipelineOutput): Transcript {
  const segments: Segment[] = []
  let lastEnd = 0

  for (const seg of json.segments ?? []) {
    for (const sent of seg.sentences ?? []) {
      const text = (sent.sentence ?? '').trim()
      if (!text) continue // an empty sentence would render as a blank segment

      let start = sent.start ?? seg.start ?? 0
      let end = sent.end ?? seg.end ?? start + 0.01
      start = Math.max(0, start)
      if (end <= start) end = start + 0.01
      lastEnd = Math.max(lastEnd, end)

      const words: Word[] = text.split(/\s+/).map((t) => ({ text: t, risk: 'low' as Risk }))

      segments.push({
        id: segments.length, // running counter → unique ids
        speaker: (sent.speaker ?? seg.speaker ?? 'Speaker') || 'Speaker',
        start,
        end,
        paraRisk: confidenceToRisk(sent.confidence),
        words: { [MODEL_KEY]: words },
      })
    }
  }

  // The validator requires a positive audioDuration and end ≤ audioDuration+0.5.
  const audioDuration =
    typeof json.audioDuration === 'number' && json.audioDuration > 0
      ? json.audioDuration
      : lastEnd || 0.01
  for (const s of segments) if (s.end > audioDuration) s.end = audioDuration

  return { audioDuration, segments }
}
