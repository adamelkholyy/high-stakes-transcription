import type { EditMode, RiskPolicy, SentenceSignal } from '../types'

export type AppMode =
  | 'full'
  | 'sentence'
  | 'sentence-uncertainty'
  | 'anomaly'
  | 'timeline'
  | 'clean-word'
  | 'clean-sentence'
  | 'clean-both'
  | 'toolkit'
  | 'complete'

// The two flagging regimes (combined-dimension display, see displayRisk.ts).
export type RiskRegime = 'deployment' | 'dense'

// Deployment regime: ASR is accurate + daily use → keep it quiet. A word is red
// only if it's in the statutory set (negation/weapon) OR is important AND
// uncertain; then cap reds at ~15% per segment (surplus → amber). Avoids alert
// fatigue. NOTE: until real cross-model uncertainty ships, `risk` is a
// placeholder (≈always low), so this ≈ "statutory set + budget".
export const DEPLOYMENT_RISK_POLICY: RiskPolicy = {
  requireUncertaintyForHigh: true,
  alwaysRed: 'statutory',
  flagBudgetPerSegmentPct: 0.15,
}

// Dense regime: pass through combined_risk unchanged (no always-red set,
// uncertainty gate, or per-segment cap).
export const DENSE_RISK_POLICY: RiskPolicy = {
  requireUncertaintyForHigh: false,
  alwaysRed: 'none',
  flagBudgetPerSegmentPct: null,
}

export const RISK_POLICY_BY_REGIME: Record<RiskRegime, RiskPolicy> = {
  deployment: DEPLOYMENT_RISK_POLICY,
  dense: DENSE_RISK_POLICY,
}

// Feature gating shared by all prototype versions.
export interface WorkspaceConfig {
  mode: AppMode
  /** Hide the brand banner row ("Transcript review" + Help). */
  hideBrandBanner?: boolean
  /** Start with the right REVIEW/audit sidebar collapsed (police cohort: more
   *  room for the transcript; the rail re-opens it). */
  defaultReviewCollapsed?: boolean
  /** Show upload-audio / upload-transcript controls + accept drag-and-drop. */
  allowUpload: boolean
  /** Show the in-browser microphone recorder. */
  allowRecord: boolean
  /** Show the playback-speed selector in the bottom player. */
  showPlaybackSpeed?: boolean
  /** Auto-transcribe uploaded/recorded audio via the ASR service (:8001). */
  allowAutoTranscribe: boolean
  /** Reviewer may freely switch the word-risk dimension. */
  allowFreeDimension: boolean
  /** Show the left Find (retrieval) panel at all. The clean highlighting-only
   *  launcher versions hide the whole left column (Find + Assistant + Outline
   *  off together) so the in-text layer is the only thing being compared. */
  allowFind: boolean
  /** Render word-level risk marks in the text. The sentence-only version turns
   *  this off (the sentence tint is the only in-text signal); every other
   *  version keeps it. */
  wordMarks: boolean
  /** Call /predict live on load/upload. */
  livePredict: boolean
  /** Show the "Outline" tab (local-LLM chaptering of long transcripts). */
  allowOutline: boolean
  /** AI assistant chat over the loaded transcript (local Ollama), as a tab
   *  beside Find. The conversation is ephemeral (in-memory, cleared on
   *  transcript change) and never enters the audit trail or an export. */
  allowChat: boolean
  /** Let the reviewer toggle the track-changes view on/off. */
  allowChangeToggle: boolean
  /** Fetch + annotate the bundled default case on mount. */
  loadDefaultCase: boolean
  /** Display-time risk operating point for the combined dimension. */
  riskPolicy: RiskPolicy
  /** Show a TopBar toggle to switch the combined-dimension regime at runtime
   *  (deployment ⇄ dense). */
  allowRiskRegimeToggle: boolean
  /** Show the light/dark theme toggle in the TopBar. */
  allowThemeToggle: boolean
  /** Progressive disclosure: when a sentence is collapsed, HIGH-risk words still
   *  get a thin subtle underline (true = "soft" — a scan-and-spot hint) vs
   *  nothing at all until the sentence is expanded (false = "pure sentence-level").
   *  The sentence-head risk dot + the expand interaction are unaffected by this
   *  flag. Flip to false to show the pure variant. */
  collapsedHighUnderline: boolean
  /** Show the header "Highlights" toggle (all ⇄ high-risk only) that hides the
   *  amber MED word highlights for a quieter read. */
  allowHighlightLevelToggle: boolean
  /** Show the header "Marks" toggle (hover ⇄ always): 'always' keeps every
   *  segment's word-level risk marks visible without hovering (useful with the
   *  high-only highlight level to scan all red words at once). */
  allowRevealAllToggle: boolean
  /** Initial word-highlight level. */
  defaultHighlightLevel: 'all' | 'high'
  /** Initial "Marks" mode. */
  defaultRevealAll: boolean
  /** Sentence-importance paradigm (the third, sentence-centric build): a local
   *  LLM triages which SENTENCES matter (binary high/low); the full word-level
   *  view is kept and important sentences get a whole-sentence highlighter on
   *  top. One interface version for the Police Scotland feedback round. */
  sentenceTriage: boolean
  /** Sentence-uncertainty paradigm: whole sentences are highlighted by the
   *  upstream sentence-level confidence (`segment.paraRisk`) — NO word-level
   *  marks. This is the interface version for sentence-confidence ASR output,
   *  returns diarisation + sentence-level confidence (not word scores).
   *  Pure client-side (reads paraRisk already in the transcript; no backend). */
  sentenceUncertainty: boolean
  /** Initial sentence-layer signal (sentence versions): what drives the
   *  whole-sentence tint — ASR 'confidence' (paraRisk), LLM 'importance'
   *  (/triage, fetched lazily on first use), or 'both' (gated combine: red =
   *  likely mis-transcribed AND important; one signal alone = amber). */
  sentenceSignal: SentenceSignal
  /** Show the "Sentences: Confidence | Importance | Both" segmented control in
   *  the transcript header so the reviewer can switch the sentence signal
   *  live. Sentence launcher versions only. */
  allowSentenceSignalToggle: boolean
  /** Show the "Editing: Assisted | Document" toggle in the View menu, letting
   *  the reviewer switch between the research-grade word-popup editing and the
   *  "edit like Word" click-and-type flow (police feedback). */
  allowEditModeToggle: boolean
  /** Initial editing interaction mode. Full/launcher default to 'assisted'
   *  (word-level candidates intact); a deployment could default to 'document'. */
  defaultEditMode: EditMode
  /** Contradiction-check paradigm (cross-sentence): a local LLM flags PAIRS of
   *  segments that appear to conflict (time/place/person/statement). Both
   *  segments get an amber tint + a left "Conflicts" tab listing the pairs
   *  with click-to-jump. Pointing aid only — the reviewer re-checks against
   *  the audio. One interface version for the feedback round. */
  anomalyDetection: boolean
  /** Event-timeline paradigm: a local LLM lists the concrete events described
   *  in the recording (with any spoken time reference) as a left "Timeline"
   *  tab; clicking an event seeks the audio to the segment it cites. One
   *  interface version for the feedback round. */
  timelineView: boolean
}

export const FULL_CONFIG: WorkspaceConfig = {
  mode: 'full',
  allowUpload: true,
  allowRecord: true,
  allowAutoTranscribe: true,
  allowFreeDimension: true,
  allowFind: true,
  wordMarks: true,
  livePredict: true,
  allowOutline: true,
  allowChat: true, // AI assistant tab beside Find (local Ollama, ephemeral)
  allowChangeToggle: true,
  loadDefaultCase: true,
  riskPolicy: DEPLOYMENT_RISK_POLICY, // default; runtime-switchable in this build
  allowRiskRegimeToggle: true,
  allowThemeToggle: true, // full build: user can switch light/dark anytime
  collapsedHighUnderline: true, // soft progressive disclosure (scan-and-spot hint)
  allowHighlightLevelToggle: true, // reviewer may hide MED highlights for a quieter read
  allowRevealAllToggle: true, // reviewer may pin all word marks visible (no hover needed)
  defaultHighlightLevel: 'high', // police review starts calm: MED marks hidden
  defaultRevealAll: true, // and all word marks pinned (no hover needed)
  sentenceTriage: false, // word-centric paradigm (sentence build is separate)
  sentenceUncertainty: false,
  sentenceSignal: 'confidence', // inert until a sentence version enables the layer
  allowSentenceSignalToggle: false,
  allowEditModeToggle: true, // reviewer can switch to "edit like Word" (police feedback)
  defaultEditMode: 'assisted',
  anomalyDetection: false, // conflict-check paradigm (anomaly build is separate)
  timelineView: false, // event-timeline paradigm (timeline build is separate)
}

// Sentence-importance build (third shell, VITE_APP_MODE=sentence): the FULL
// build verbatim — every feature, same word-level highlighting — plus ONE
// addition: an LLM sentence-importance layer that highlighter-marks whole
// important sentences (no head dot). For the Police Scotland feedback round:
// officers compare "word version" (full) vs "word + sentence version" (this).
export const SENTENCE_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'sentence',
  sentenceTriage: true,
}

// Sentence-uncertainty build: whole sentences highlighted by the upstream
// sentence-level confidence (`segment.paraRisk`), no word-level marks. This is
// the interface version for diarised ASR output (sentence confidence, no word
// scores) and the sentence-uncertainty version requested during design review
// asked for. Word-dimension controls are hidden (there are no word scores to
// switch between); reads paraRisk already in the transcript — no backend call.
export const SENTENCE_UNCERTAINTY_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'sentence-uncertainty',
  allowFreeDimension: false, // no Risk dropdown — word signals are meaningless here
  allowRiskRegimeToggle: false,
  livePredict: false, // pure client-side: paraRisk drives everything, no /predict call
  sentenceUncertainty: true,
  wordMarks: false, // sentence tint is the only in-text signal
}

// Contradiction-check build: the FULL build verbatim plus ONE addition — a
// local LLM cross-checks the statements and flags pairs that appear to
// conflict (amber tint on both + a "Conflicts" tab with click-to-jump). For
// the feedback round: "does an AI that points at inconsistencies help?"
export const ANOMALY_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'anomaly',
  anomalyDetection: true,
}

// Event-timeline build: the FULL build verbatim plus ONE addition — a local
// LLM lists the concrete events described (with spoken time references) as a
// clickable "Timeline" tab that seeks the audio. For the feedback round:
// "does an AI-built event timeline help navigate a recording?"
export const TIMELINE_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'timeline',
  timelineView: true,
}

// ---------------------------------------------------------------------------
// Launcher versions for the Police Scotland feedback round (restructured
// 2026-07-07). Two clean axes so every adjacent pair differs by ONE thing:
//   in-text highlighting: word / sentence / both   ×   AI toolkit: none / all
// The sentence layer is the ASR sentence CONFIDENCE (`paraRisk` from the
// ensemble, via the adapter) — the LLM-importance triage build stays available
// as SENTENCE_CONFIG (VITE_APP_MODE=sentence) but is off in all five.
// "Clean" = the whole left column (Find / Assistant / Outline) is hidden; the
// review core (audio, verify, edit, audit, export) is identical everywhere.
// ---------------------------------------------------------------------------

export const CLEAN_WORD_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'clean-word',
  allowFind: false,
  allowOutline: false,
  allowChat: false,
}

export const CLEAN_SENTENCE_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'clean-sentence',
  allowFind: false,
  allowOutline: false,
  allowChat: false,
  allowFreeDimension: false, // no word signals → no Risk dropdown
  allowRiskRegimeToggle: false,
  allowHighlightLevelToggle: false, // word-mark controls would be dead here
  allowRevealAllToggle: false,
  livePredict: false, // no word marks → no /predict call
  sentenceUncertainty: true,
  wordMarks: false,
  allowSentenceSignalToggle: true, // Confidence | Importance | Both, live-switchable
}

export const CLEAN_BOTH_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'clean-both',
  allowFind: false,
  allowOutline: false,
  allowChat: false,
  sentenceUncertainty: true, // word marks stay on (wordMarks true via FULL)
  allowSentenceSignalToggle: true,
}

export const TOOLKIT_CONFIG: WorkspaceConfig = {
  ...FULL_CONFIG,
  mode: 'toolkit',
  anomalyDetection: true,
  timelineView: true,
}

export const COMPLETE_CONFIG: WorkspaceConfig = {
  ...TOOLKIT_CONFIG,
  mode: 'complete',
  sentenceUncertainty: true,
  allowSentenceSignalToggle: true,
}
