/**
 * Unit tests for the two-regime display-risk policy (displayRisk.ts).
 * No test runner is configured, so this is plain assertions with a runner:
 *   npx tsx src/lib/displayRisk.test.ts
 *
 * Covers: dense pass-through (no transform), the deployment gate (always-red
 * set, require-uncertainty demotion), and the per-segment flag budget.
 */
import type { ModelName, Risk, RiskPolicy, Segment, Transcript, Word } from '../types'
import { buildDisplayRiskMap, isPassThroughPolicy } from './displayRisk'

const MODEL = 'whisper-large' as ModelName

const DEPLOY: RiskPolicy = {
  requireUncertaintyForHigh: true,
  alwaysRed: 'statutory',
  flagBudgetPerSegmentPct: 0.15,
}
const DENSE: RiskPolicy = {
  requireUncertaintyForHigh: false,
  alwaysRed: 'none',
  flagBudgetPerSegmentPct: null,
}

function w(
  text: string,
  imp: Risk,
  unc: Risk,
  pHigh = 0,
  combined: Risk = imp,
): Word {
  return {
    text,
    risk: unc,
    predicted_importance: imp,
    predicted_proba: { high: pHigh, med: 0, low: 0 },
    combined_risk: combined,
  }
}

function seg(id: number, words: Word[]): Segment {
  return { id, speaker: 'Speaker', start: 0, end: 1, paraRisk: 'low', words: { [MODEL]: words } }
}

function transcriptOf(...segs: Segment[]): Transcript {
  return { audioDuration: 1, segments: segs }
}

function risksOf(t: Transcript, policy: RiskPolicy): Risk[] {
  const map = buildDisplayRiskMap(t, MODEL, policy)
  if (!map) throw new Error('expected a non-null map')
  const words = t.segments[0].words[MODEL]
  return words.map((_, i) => map.get(`0-${i}`)!)
}

// ---------------------------------------------------------------------------

function test_passthrough_is_null() {
  assert(isPassThroughPolicy(DENSE), 'dense policy is pass-through')
  assert(!isPassThroughPolicy(DEPLOY), 'deploy policy is NOT pass-through')
  const t = transcriptOf(seg(0, [w('gun', 'high', 'low', 0.9)]))
  assert(buildDisplayRiskMap(t, MODEL, DENSE) === null, 'dense policy returns null map')
}

function test_deploy_gate() {
  // no budget so we isolate the gate
  const policy: RiskPolicy = { ...DEPLOY, flagBudgetPerSegmentPct: null }
  const t = transcriptOf(
    seg(0, [
      w('not', 'low', 'low', 0.1),                  // always-red (negation)
      w('gun', 'high', 'low', 0.2),                 // always-red (weapon)
      w('evidence', 'high', 'low', 0.9, 'high'),    // important but CONFIDENT → demote
      w('vehicle', 'high', 'med', 0.8),             // important AND uncertain → high
      w('the', 'low', 'low', 0.0),                  // nothing
    ]),
  )
  const r = risksOf(t, policy)
  assertEq(r[0], 'high', 'negation always-red')
  assertEq(r[1], 'high', 'weapon always-red')
  assertEq(r[2], 'med', 'important+confident demoted to amber')
  assertEq(r[3], 'high', 'important+uncertain stays high')
  assertEq(r[4], 'low', 'unimportant stays low')
}

function test_uncertainty_alone_never_high() {
  const policy: RiskPolicy = { ...DEPLOY, flagBudgetPerSegmentPct: null }
  // low importance, HIGH uncertainty, combined says med → must not be red
  const t = transcriptOf(seg(0, [w('umm', 'low', 'high', 0.0, 'med')]))
  assertEq(risksOf(t, policy)[0], 'med', 'uncertainty alone caps at amber')
}

function test_flag_budget() {
  // 20 content words; cap = ceil(0.15*20) = 3. Two are always-red (exempt),
  // leaving room for 1 more red among the importance+uncertain candidates.
  const words: Word[] = [
    w('not', 'low', 'low', 0.1),   // always-red
    w('knife', 'high', 'low', 0.2), // always-red
  ]
  // 6 important+uncertain candidates with descending P(HIGH); only the top one
  // should survive the budget, the rest demote to amber.
  const pHighs = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7]
  pHighs.forEach((p, k) => words.push(w(`cand${k}`, 'high', 'med', p)))
  // pad to 20 content words with low/low fillers
  while (words.length < 20) words.push(w(`x${words.length}`, 'low', 'low', 0))

  const r = risksOf(transcriptOf(seg(0, words)), DEPLOY)
  const highCount = r.filter((x) => x === 'high').length
  assertEq(highCount, 3, 'budget caps reds at 3 (2 always-red + 1 candidate)')
  assertEq(r[2], 'high', 'highest-P(HIGH) candidate kept red')
  assertEq(r[3], 'med', 'next candidate demoted to amber')
  assertEq(r[7], 'med', 'lowest candidate demoted to amber')
}

// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}
function assertEq(got: unknown, want: unknown, msg: string) {
  if (got !== want) throw new Error(`FAIL: ${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

const tests = [
  test_passthrough_is_null,
  test_deploy_gate,
  test_uncertainty_alone_never_high,
  test_flag_budget,
]
let passed = 0
for (const t of tests) {
  try {
    t()
    console.log('  PASS  ' + t.name)
    passed++
  } catch (e) {
    console.log('  ' + (e as Error).message + `  [${t.name}]`)
  }
}
console.log(`\n${passed}/${tests.length} passed`)
if (passed !== tests.length) process.exit(1)
