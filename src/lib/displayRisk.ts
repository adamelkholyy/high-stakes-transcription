import type { ModelName, Risk, RiskPolicy, Segment, Transcript, Word } from '../types'

// ---------------------------------------------------------------------------
// Display-time risk policy — the tunable "operating point" (see RiskPolicy).
// This is a pure, config-driven post-process of the per-word signals that the
// backend already bakes in (predicted_importance from the L1 cascade,
// predicted_proba, combined_risk, and the upstream `risk` = uncertainty). It
// only re-maps the COMBINED dimension; uncertainty / importance / none render
// as-is. A dense pass-through policy leaves the source rendering unchanged.
// ---------------------------------------------------------------------------

// Statutory always-red lexicon: negations + weapons. Mirrors the core of the
// server-side L1 HIGH lexicon (server/l1_rules.py) — kept tiny + frontend-local
// so the deployment regime can keep these red even at low uncertainty (the
// "confidently wrong" gun/not cell) without a backend round-trip. Matched on
// the punctuation-stripped, lowercased token.
const ALWAYS_RED = new Set<string>([
  // negations
  'not', 'no', 'never', 'nothing', 'nobody', 'none', 'neither', 'nor', "n't", 'n’t',
  // weapons
  'gun', 'guns', 'knife', 'knives', 'weapon', 'weapons', 'blade',
  'pistol', 'revolver', 'rifle', 'shotgun', 'glock', 'machete',
])

const RANK: Record<Risk, number> = { low: 0, med: 1, high: 2 }
const PUNCT_EDGE = /^[.,!?;:"'()[\]]+|[.,!?;:"'()[\]]+$/g

function cleanToken(text: string): string {
  return text.replace(PUNCT_EDGE, '').toLowerCase()
}

/** A pass-through policy = no transform; callers can skip building a map. */
export function isPassThroughPolicy(p: RiskPolicy): boolean {
  return (
    p.alwaysRed === 'none' &&
    !p.requireUncertaintyForHigh &&
    p.flagBudgetPerSegmentPct == null
  )
}

// Per-word display risk for the COMBINED dimension, for one segment's words.
// Index-aligned with `words`. Budget is per-segment, hence the segment grain.
function segmentDisplayRisk(words: Word[], policy: RiskPolicy): Risk[] {
  const n = words.length
  const out: Risk[] = new Array(n).fill('low')
  const wantHigh: boolean[] = new Array(n).fill(false)
  const alwaysRed: boolean[] = new Array(n).fill(false)
  let contentCount = 0

  for (let i = 0; i < n; i++) {
    const w = words[i]
    const cleaned = cleanToken(w.text)
    if (cleaned !== '') contentCount += 1
    const imp = w.predicted_importance ?? w.risk
    const unc = w.risk
    const ar = policy.alwaysRed === 'statutory' && ALWAYS_RED.has(cleaned)
    alwaysRed[i] = ar
    wantHigh[i] =
      ar ||
      (policy.requireUncertaintyForHigh ? imp === 'high' && RANK[unc] >= 1 : imp === 'high')
  }

  // Flag budget: always-red are exempt; the rest compete for the remaining slots
  // by P(HIGH) (the continuous importance score). Surplus would-be-reds → amber.
  let allowedExtra = Infinity
  if (policy.flagBudgetPerSegmentPct != null) {
    const cap = Math.ceil(policy.flagBudgetPerSegmentPct * contentCount)
    const alwaysRedCount = alwaysRed.reduce((a, b) => a + (b ? 1 : 0), 0)
    allowedExtra = Math.max(0, cap - alwaysRedCount)
  }
  const candidates: number[] = []
  for (let i = 0; i < n; i++) if (wantHigh[i] && !alwaysRed[i]) candidates.push(i)
  candidates.sort(
    (a, b) => (words[b].predicted_proba?.high ?? 0) - (words[a].predicted_proba?.high ?? 0),
  )
  const keep = new Set(candidates.slice(0, allowedExtra))

  for (let i = 0; i < n; i++) {
    if (alwaysRed[i] || (wantHigh[i] && keep.has(i))) {
      out[i] = 'high'
    } else if (wantHigh[i]) {
      out[i] = 'med' // demoted by the budget → amber
    } else {
      // Not a HIGH candidate: keep its med/low, but never let a stray combined
      // HIGH through (e.g. importance-high + low-uncertainty in deployment) —
      // cap at amber. uncertainty alone is already never HIGH (see combine()).
      const cr = words[i].combined_risk ?? words[i].risk
      out[i] = cr === 'high' ? 'med' : cr
    }
  }
  return out
}

/**
 * Build a `${segId}-${wordIdx}` → Risk map for the whole transcript under the
 * policy. Returns null for a pass-through policy (callers fall back to the raw
 * `combined_risk`). Only meaningful for the combined dimension.
 */
export function buildDisplayRiskMap(
  transcript: Transcript,
  model: ModelName,
  policy: RiskPolicy,
): Map<string, Risk> | null {
  if (isPassThroughPolicy(policy)) return null
  const map = new Map<string, Risk>()
  for (const seg of transcript.segments) {
    const words = seg.words[model] ?? []
    const risks = segmentDisplayRisk(words, policy)
    for (let i = 0; i < risks.length; i++) map.set(`${seg.id}-${i}`, risks[i])
  }
  return map
}

/** Segment-level risk = max of the policy's per-word display risks (focus wins). */
export function combinedSegmentRisk(
  segment: Segment,
  model: ModelName,
  map: Map<string, Risk>,
  focused: boolean,
): Risk {
  if (focused) return 'high'
  const words = segment.words[model] ?? []
  let max: Risk = 'low'
  for (let i = 0; i < words.length; i++) {
    const r = map.get(`${segment.id}-${i}`)
    if (r && RANK[r] > RANK[max]) max = r
  }
  return max
}
