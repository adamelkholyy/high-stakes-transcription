import type { HighlightLayer, ModelName, Risk, Segment } from '../types'

const RANK: Record<Risk, number> = { low: 0, med: 1, high: 2 }
const BY_RANK: Risk[] = ['low', 'med', 'high']

/**
 * The upstream `segment.paraRisk` is computed from the *uncertainty* signal
 * only. When the reviewer switches to the importance or combined view, the
 * left-bar colour, the "HIGH RISK" badge, the per-segment filter, and the
 * chip counts in the header all need to follow that signal.
 *
 * We re-aggregate from per-word risk = max of the selected dimension's risk
 * across the segment's words (under the currently selected ASR model). The
 * importance/combined fields may not exist yet (prediction service down or
 * pending) — in that case the per-word fallback in Word.tsx kicks in and we
 * end up equivalent to the uncertainty signal, which is the safe default.
 */
export function segmentRiskFor(
  segment: Segment,
  model: ModelName,
  dimension: HighlightLayer,
): Risk {
  // C1 (plain text): no risk colouring at all.
  if (dimension === 'none') return 'low'
  // Fall back to upstream paraRisk for uncertainty when the segment hasn't
  // been re-emitted by the prediction service yet — preserves existing
  // behaviour exactly when nothing else is available.
  if (dimension === 'uncertainty') return segment.paraRisk

  const words = segment.words[model] ?? []
  let maxRank = RANK.low
  for (const w of words) {
    const r: Risk =
      dimension === 'importance'
        ? w.predicted_importance ?? w.risk
        : w.combined_risk ?? w.risk
    if (RANK[r] > maxRank) maxRank = RANK[r]
    if (maxRank === RANK.high) return 'high' // early exit
  }
  return BY_RANK[maxRank]
}

/**
 * Focus-aware segment risk (2b overlay). A segment that contains a focus match
 * reads HIGH regardless of the default dimension, so the left bar, the
 * segment filter and the header chips agree with the focus highlights. When focus
 * is inactive this is exactly `segmentRiskFor`, so default behaviour is
 * unchanged. The underlying 2a scores are never mutated — this is display only.
 */
export function segmentRiskWithFocus(
  segment: Segment,
  model: ModelName,
  dimension: HighlightLayer,
  focused: boolean,
): Risk {
  if (focused) return 'high'
  return segmentRiskFor(segment, model, dimension)
}
