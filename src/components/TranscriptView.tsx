import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditMode, EditState, FocusWordHit, HighlightLayer, ModelName, Risk, RiskDimension, Segment as SegmentType, SentenceSignal, Transcript } from '../types'
import { segmentRiskWithFocus } from '../lib/segmentRisk'
import { combinedSegmentRisk } from '../lib/displayRisk'
import Segment from './Segment'
import { Menu, MenuItem, MenuRow, MenuSection } from './Menu'

interface Props {
  transcript: Transcript
  model: ModelName
  currentTime: number
  edits: Record<string, EditState>
  verified: Record<number, boolean>
  dimension: HighlightLayer
  // Per-word display-risk override for the combined dimension. null means the
  // source combined_risk values pass through unchanged.
  displayRiskMap?: Map<string, Risk> | null
  // Progressive disclosure: which segment (if any) is expanded to word level.
  expandedSegmentId: number | null
  onToggleExpand: (segId: number) => void
  // Single-click a segment → seek there + play it (and pin it open).
  onPlaySegment: (segId: number) => void
  collapsedHighUnderline: boolean
  // C1 hides the risk chips + Show/Highlights/Marks controls (plain text, no risk shown).
  showViewControls?: boolean
  // Focus mode (2b): which segments hold a hit + a per-word marker lookup.
  focusActive: boolean
  focusSegmentIds: Set<number>
  focusHitFor?: (segId: number, wordIdx: number) => FocusWordHit | undefined
  /** Sentence builds: per-segment whole-sentence tint level (importance from
   *  the LLM, or uncertainty from paraRisk). Present → head dot hidden. */
  sentenceTintMap?: Map<number, Risk>
  /** Sentence builds: tooltip for a tinted sentence. */
  sentenceTintTitleFor?: (segId: number) => string | undefined
  /** Pure sentence-highlight version (sentence tint is the only in-text signal).
   *  Turns the "Show" control into a highlight-LEVEL control instead of a
   *  visibility filter: every sentence stays shown (order unchanged); the choice
   *  only decides whether MEDIUM sentences are tinted. "High + medium" tints
   *  both; "High risk only" tints high and leaves medium untinted. */
  sentenceHighlightControl?: boolean
  /** Keep the segment head risk dot even when a tint map is present. The
   *  anomaly build sets this: it is "FULL plus conflict tints", so the word
   *  version's dot must survive (the sentence builds drop it). */
  keepRiskDot?: boolean
  /** Sentence-layer signal selector (sentence launcher versions): current
   *  value + change handler render a "Sentences: Confidence | Importance |
   *  Both" segmented control in the header; busy shows while the importance
   *  ranking is being fetched. Absent handler → no control. */
  sentenceSignal?: SentenceSignal
  onSentenceSignalChange?: (signal: SentenceSignal) => void
  sentenceSignalBusy?: boolean
  /** Word-dimension selector (word launcher versions): current dimension +
   *  change handler render a visible "Words: Uncertainty | Importance |
   *  Combined" segmented control in the header. Absent handler → no control. */
  wordDimensionValue?: RiskDimension
  onWordDimensionChange?: (d: RiskDimension) => void
  /** Override the dimension used for WORD marks only (segment risk / chips
   *  still follow `dimension`). The sentence-uncertainty version passes 'none'
   *  to suppress word marks while chips reflect paraRisk. */
  wordDimension?: HighlightLayer
  onSeek: (seconds: number) => void
  onWordClick: (segId: number, wordIdx: number, rect: DOMRect) => void
  onToggleVerify: (segId: number, opts?: { range?: boolean }) => void
  onBulkVerify?: (segIds: number[], value: boolean) => void
  /** Show reviewer verification controls. */
  showVerifyControls?: boolean
  // #1 whole-sentence edit + #2 structural edits, threaded to each Segment.
  segmentTextEdits?: Record<number, { text: string; reason?: string }>
  onEditSentence?: (segId: number, text: string) => void
  onMergeNext?: (segId: number) => void
  /** "Split here" from the line editor: draft text already cut at the cursor. */
  onSplitDraft?: (segId: number, textA: string, textB: string) => void
  onChangeSpeaker?: (segId: number, speaker: string) => void
  /** Editing interaction mode + its toggle. When onEditModeChange is provided,
   *  an "Editing: Assisted | Document" control shows in the View menu. */
  editMode?: EditMode
  onEditModeChange?: (mode: EditMode) => void
  // Header "Highlights" toggle: hide MED word highlights.
  showHighlightLevel?: boolean
  // Initial highlight level / marks mode (build-specific defaults from config).
  defaultHighlightLevel?: HighlightLevel
  defaultRevealAll?: boolean
  // Header "Marks" toggle: keep every segment's word-level
  // risk marks visible without hovering (vs the default hover/play reveal).
  showRevealAll?: boolean
  // Track-changes view + per-segment "<reviewer> · <hh:mm>" of the last edit.
  showChanges?: boolean
  editInfo?: Record<number, { reviewer: string; time: string }>
}

const RISK_CHIP: Record<Risk, string> = {
  high: 'bg-risk-high-bg/80 text-risk-high',
  med: 'bg-risk-med-bg/80 text-risk-med',
  low: 'bg-surface-subtle text-ink-muted',
}

// Sentence-signal segmented control (sentence launcher versions).
const SIGNAL_LABEL: Record<SentenceSignal, string> = {
  confidence: 'Confidence',
  importance: 'Importance',
  both: 'Both',
}
const SIGNAL_TIP: Record<SentenceSignal, string> = {
  confidence: 'Tint sentences by how confident the speech-recognition was — low confidence stands out',
  importance: 'Tint the sentences where a transcription error would matter most (AI-ranked)',
  both: 'Red = likely mis-transcribed AND important; one signal alone shows amber',
}

// Word-dimension segmented control (word launcher versions) — the visible
// equivalent of the Sentences selector, so the uncertainty/importance/combined
// switch isn't buried in a menu (police feedback).
const WORD_DIM_LABEL: Record<RiskDimension, string> = {
  uncertainty: 'Uncertainty',
  importance: 'Importance',
  combined: 'Combined',
}
const WORD_DIM_TIP: Record<RiskDimension, string> = {
  uncertainty: 'Mark words the speech-recognition was unsure about (likely mis-heard)',
  importance: 'Mark words that would matter most if wrong (names, dates, weapons, negations)',
  combined: 'Mark words that are both likely wrong AND important',
}

type RiskFilter = 'all' | 'high+med' | 'high'
// Word-highlight level: 'all' = full red + amber treatment; 'high' = hide the
// amber MED word highlights for a quieter read.
export type HighlightLevel = 'all' | 'high'

function applyFilter(
  segments: SegmentType[],
  filter: RiskFilter,
  riskOf: (s: SegmentType) => Risk,
): SegmentType[] {
  if (filter === 'all') return segments
  if (filter === 'high') return segments.filter((s) => riskOf(s) === 'high')
  return segments.filter((s) => riskOf(s) !== 'low')
}

export default function TranscriptView({
  transcript,
  model,
  currentTime,
  edits,
  verified,
  dimension,
  displayRiskMap,
  expandedSegmentId,
  onToggleExpand,
  onPlaySegment,
  collapsedHighUnderline,
  showViewControls = true,
  focusActive,
  focusSegmentIds,
  focusHitFor,
  sentenceTintMap,
  sentenceTintTitleFor,
  sentenceHighlightControl = false,
  keepRiskDot = false,
  sentenceSignal,
  onSentenceSignalChange,
  sentenceSignalBusy = false,
  wordDimensionValue,
  onWordDimensionChange,
  wordDimension,
  onSeek,
  onWordClick,
  onToggleVerify,
  onBulkVerify,
  showVerifyControls = true,
  segmentTextEdits,
  onEditSentence,
  onMergeNext,
  onSplitDraft,
  onChangeSpeaker,
  editMode = 'assisted',
  onEditModeChange,
  showHighlightLevel = false,
  defaultHighlightLevel = 'all',
  defaultRevealAll = false,
  showRevealAll = false,
  showChanges = true,
  editInfo,
}: Props) {
  const [filter, setFilter] = useState<RiskFilter>('all')
  const [highlightLevel, setHighlightLevel] = useState<HighlightLevel>(defaultHighlightLevel)
  // Follow the configured default when it changes between launcher versions.
  useEffect(() => setHighlightLevel(defaultHighlightLevel), [defaultHighlightLevel])
  // 'Marks: always' — pin word-level risk marks on every segment (no hover
  // needed). Pairs well with highlightLevel='high' to scan all red words.
  const [revealAll, setRevealAll] = useState(defaultRevealAll)
  // Transient hover-reveal: hovering a segment shows its
  // word-level risk; moving away collapses it (unless pinned/playing).
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const handleHover = useCallback((id: number | null) => setHoveredId(id), [])

  const selectFilter = (next: RiskFilter) => setFilter(next)
  const selectHighlightLevel = (next: HighlightLevel) => setHighlightLevel(next)
  const toggleRevealAll = () => setRevealAll((value) => !value)

  // Active segment is always computed from the FULL transcript, so the
  // "currently playing" highlight tracks audio regardless of filter.
  const activeId = useMemo(() => {
    const seg = transcript.segments.find(
      (s) => currentTime >= s.start && currentTime < s.end,
    )
    return seg?.id ?? null
  }, [transcript, currentTime])

  // Karaoke: index of the word currently being spoken, scanned in the ACTIVE
  // segment only (cheap — ~tens of words, not the whole transcript). null when
  // no segment is active or the words carry no timestamps (graceful no-op).
  // Plain (dimension='none') deliberately disables word-follow highlighting.
  const activeWordIndex = useMemo(() => {
    if (dimension === 'none') return null
    if (activeId == null) return null
    const seg = transcript.segments.find((s) => s.id === activeId)
    const ws = seg?.words[model] ?? []
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i]
      if (w.start != null && w.end != null && currentTime >= w.start && currentTime < w.end) return i
    }
    return null
  }, [transcript, model, activeId, currentTime, dimension])

  // Capture the active dimension's risk lookup so the filter and counts
  // agree with the segment-level bar shown on the left. In focus mode a
  // segment with a hit reads HIGH, so it surfaces under "High risk only" too.
  const riskOf = useMemo(
    () => (s: SegmentType) => {
      const focused = focusActive && focusSegmentIds.has(s.id)
      return displayRiskMap
        ? combinedSegmentRisk(s, model, displayRiskMap, focused)
        : segmentRiskWithFocus(s, model, dimension, focused)
    },
    [model, dimension, focusActive, focusSegmentIds, displayRiskMap],
  )

  const displaySegments = useMemo(
    // Pure sentence version: the "Show" control never hides — it only re-tints
    // (handled per-segment below), so every segment stays visible, in order.
    () =>
      sentenceHighlightControl
        ? transcript.segments
        : applyFilter(transcript.segments, filter, riskOf),
    [transcript, filter, riskOf, sentenceHighlightControl],
  )

  const activeRef = useRef<HTMLDivElement>(null)
  const scrollRootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeId])

  const counts = useMemo(
    () =>
      transcript.segments.reduce(
        (acc, s) => {
          acc[riskOf(s)] += 1
          return acc
        },
        { high: 0, med: 0, low: 0 } as Record<Risk, number>,
      ),
    [transcript, riskOf],
  )

  // The amber view-state pill only reflects the segment FILTER (where "N of M"
  // is meaningful). Highlight level / marks are self-evident on screen.
  // The pure sentence version never hides segments, so the "N of M" filter pill
  // is meaningless there — treat it as the default view regardless of level.
  const isDefaultView = filter === 'all' || sentenceHighlightControl

  return (
    <main ref={scrollRootRef} className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-5">
        {/* Highlight controls stay reachable deep into the transcript: the row
            sticks to the top of the scroll area (negative margins + padding
            re-cover the column's own top/side padding so text slides under a
            solid background, not past a floating strip). */}
        <div className="sticky top-0 z-20 bg-surface -mx-8 px-8 -mt-5 pt-5 mb-6 pb-4 border-b border-border">
          {/* Risk chips + a "View" menu (hidden in C1 — plain text). */}
          {showViewControls && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={`px-2 py-0.5 rounded-full font-mono tabular-nums ${RISK_CHIP.high}`}>
              {counts.high} high
            </span>
            <span className={`px-2 py-0.5 rounded-full font-mono tabular-nums ${RISK_CHIP.med}`}>
              {counts.med} med
            </span>

            {/* Word-dimension selector (word launcher versions): switches which
                signal drives the word marks; the visible equivalent of the old
                buried Risk dropdown. First selector on the row carries ml-auto. */}
            {onWordDimensionChange && wordDimensionValue && (
              <div className="ml-auto flex items-center gap-1.5" data-tour="words-toggle">
                <span className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Words
                </span>
                <div className="flex rounded-md border border-border overflow-hidden">
                  {(Object.keys(WORD_DIM_LABEL) as RiskDimension[]).map((d) => (
                    <button
                      key={d}
                      onClick={() => onWordDimensionChange(d)}
                      title={WORD_DIM_TIP[d]}
                      className={[
                        'px-2 py-0.5 text-[11px] transition-colors',
                        wordDimensionValue === d
                          ? 'bg-brand text-white'
                          : 'bg-surface text-ink-muted hover:text-ink hover:bg-surface-muted',
                      ].join(' ')}
                    >
                      {WORD_DIM_LABEL[d]}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Sentence-signal selector (sentence launcher versions): switches
                what the whole-sentence tint encodes. */}
            {onSentenceSignalChange && sentenceSignal && (
              <div
                className={`${onWordDimensionChange && wordDimensionValue ? '' : 'ml-auto '}flex items-center gap-1.5`}
                data-tour="sentences-toggle"
              >
                <span className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                  Sentences
                </span>
                <div className="flex rounded-md border border-border overflow-hidden">
                  {(Object.keys(SIGNAL_LABEL) as SentenceSignal[]).map((s) => (
                    <button
                      key={s}
                      onClick={() => onSentenceSignalChange(s)}
                      title={SIGNAL_TIP[s]}
                      className={[
                        'px-2 py-0.5 text-[11px] transition-colors',
                        sentenceSignal === s
                          ? 'bg-brand text-white'
                          : 'bg-surface text-ink-muted hover:text-ink hover:bg-surface-muted',
                      ].join(' ')}
                    >
                      {SIGNAL_LABEL[s]}
                    </button>
                  ))}
                </div>
                {sentenceSignalBusy && (
                  <span className="text-[10px] text-ink-faint animate-pulse">ranking…</span>
                )}
              </div>
            )}

            <Menu
              className={
                (onWordDimensionChange && wordDimensionValue) ||
                (onSentenceSignalChange && sentenceSignal)
                  ? undefined
                  : 'ml-auto'
              }
              align="right"
              title="View options"
              dataTour="view-menu"
              triggerClassName="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink border border-border rounded-md px-2 py-0.5 bg-surface hover:border-border-strong transition-colors"
              trigger={(open) => (
                <>
                  View
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    className={`transition-transform ${open ? 'rotate-180' : ''}`}
                  >
                    <path d="M1.5 3 4 5.5 6.5 3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </>
              )}
            >
              {() => (
                <>
                  <MenuRow label={sentenceHighlightControl ? 'Highlight' : 'Show'}>
                    <select
                      value={filter}
                      onChange={(e) => selectFilter(e.target.value as RiskFilter)}
                      className="text-[11px] border border-border rounded-md px-1.5 py-0.5 bg-surface hover:border-border-strong focus:outline-none focus:ring-1 focus:ring-border-strong"
                    >
                      {sentenceHighlightControl ? (
                        // Highlight-LEVEL, not a filter: every sentence stays shown.
                        // 'all' tints high + medium; 'high' tints high only.
                        <>
                          <option value="all">High + medium</option>
                          <option value="high">High risk only</option>
                        </>
                      ) : (
                        <>
                          <option value="all">All segments</option>
                          <option value="high+med">High + medium</option>
                          <option value="high">High risk only</option>
                        </>
                      )}
                    </select>
                  </MenuRow>
                  {showHighlightLevel && (
                    <MenuRow label="Highlights">
                      <select
                        value={highlightLevel}
                        onChange={(e) => selectHighlightLevel(e.target.value as HighlightLevel)}
                        title="Hiding medium keeps only the red high-risk marks"
                        className="text-[11px] border border-border rounded-md px-1.5 py-0.5 bg-surface hover:border-border-strong focus:outline-none focus:ring-1 focus:ring-border-strong"
                      >
                        <option value="all">All highlights</option>
                        <option value="high">Hide medium</option>
                      </select>
                    </MenuRow>
                  )}
                  {showRevealAll && (
                    <MenuRow label="Marks">
                      <button
                        onClick={toggleRevealAll}
                        title={
                          revealAll
                            ? 'Word marks are pinned on every segment — click to reveal on hover/play only'
                            : 'Word marks appear on hover/play — click to pin them on every segment'
                        }
                        className={[
                          'text-[11px] px-2 py-0.5 rounded-md border transition-colors',
                          revealAll
                            ? 'border-brand/50 text-brand bg-brand-bg'
                            : 'border-border text-ink-muted bg-surface hover:border-border-strong',
                        ].join(' ')}
                      >
                        {revealAll ? 'Always' : 'On hover'}
                      </button>
                    </MenuRow>
                  )}
                  {onEditModeChange && (
                    <MenuRow label="Editing">
                      <div className="flex rounded-md border border-border overflow-hidden">
                        {(['assisted', 'document'] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => onEditModeChange(m)}
                            title={
                              m === 'assisted'
                                ? 'Click a word for candidates & options; edit sentences in a panel'
                                : 'Edit like a document: click the text and just type'
                            }
                            className={[
                              'px-2 py-0.5 text-[11px] transition-colors',
                              editMode === m
                                ? 'bg-brand text-white'
                                : 'bg-surface text-ink-muted hover:text-ink hover:bg-surface-muted',
                            ].join(' ')}
                          >
                            {m === 'assisted' ? 'Assisted' : 'Like Word'}
                          </button>
                        ))}
                      </div>
                    </MenuRow>
                  )}
                  {showVerifyControls && onBulkVerify && (
                    <MenuSection label="Verify">
                      <MenuItem
                        onClick={() => onBulkVerify(displaySegments.map((s) => s.id), true)}
                        title="Verify every currently-shown segment"
                      >
                        ✓ Verify all shown{!sentenceHighlightControl && filter !== 'all' ? ` (${displaySegments.length})` : ''}
                      </MenuItem>
                      <MenuItem
                        onClick={() => onBulkVerify(displaySegments.map((s) => s.id), false)}
                        title="Un-verify every currently-shown segment"
                      >
                        Un-verify all shown
                      </MenuItem>
                    </MenuSection>
                  )}
                </>
              )}
            </Menu>
          </div>
          )}

          {/* View-state indicator. */}
          {showViewControls && !isDefaultView && (
            <div className="mt-3 flex items-center gap-2">
              <span className="inline-flex items-center gap-2 text-[11px] text-risk-med bg-risk-med-bg border border-risk-med/30 rounded-sm px-2 py-0.5">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1 2h8M2 5h6M3 8h4" strokeLinecap="round" />
                </svg>
                <span className="font-mono tabular-nums">
                  {displaySegments.length} of {transcript.segments.length}
                </span>
                <span>
                  {filter === 'high' ? 'high-risk only' : 'high + medium'}
                </span>
              </span>
              <button
                onClick={() => selectFilter('all')}
                className="text-[11px] text-ink-muted hover:text-ink underline decoration-dotted underline-offset-2"
              >
                Reset view
              </button>
            </div>
          )}

        </div>

        <div className="space-y-0.5">
          {displaySegments.length === 0 ? (
            <p className="py-12 text-center text-xs text-ink-faint italic">
              No segments match the current filter.
            </p>
          ) : (
            displaySegments.map((segment) => {
              // "High risk only" (filter==='high') in the pure sentence version
              // drops the MEDIUM (amber) tint so only high-risk sentences stand
              // out — everything still shown. "High + medium" tints both.
              const rawTint = sentenceTintMap?.get(segment.id)
              const shownTint =
                sentenceHighlightControl && filter === 'high' && rawTint === 'med'
                  ? undefined
                  : rawTint
              return (
              <div
                key={segment.id}
                ref={segment.id === activeId ? activeRef : null}
                data-segment-id={segment.id}
                data-segment-start={segment.start}
                data-segment-risk={riskOf(segment)}
              >
                <Segment
                  segment={segment}
                  model={model}
                  active={segment.id === activeId}
                  verified={!!verified[segment.id]}
                  edits={edits}
                  // Word-mark dimension: an explicit override ('none' for the
                  // pure-sentence build) wins; else the header WORDS switcher
                  // (when free switching is on) — without this the switcher
                  // only restyled itself and words stayed on the sentence
                  // build's pinned dimension; else the version's fixed layer.
                  dimension={wordDimension ?? wordDimensionValue ?? dimension}
                  hideRiskDot={!!sentenceTintMap && !keepRiskDot}
                  sentenceTint={shownTint}
                  sentenceTintTitle={shownTint ? sentenceTintTitleFor?.(segment.id) : undefined}
                  expanded={revealAll || segment.id === expandedSegmentId || segment.id === hoveredId}
                  onToggleExpand={onToggleExpand}
                  onPlaySegment={onPlaySegment}
                  onHover={handleHover}
                  segmentRisk={riskOf(segment)}
                  collapsedHighUnderline={collapsedHighUnderline}
                  highlightLevel={highlightLevel}
                  activeWordIndex={segment.id === activeId ? activeWordIndex : null}
                  activeTime={
                    dimension !== 'none' && segment.id === activeId ? currentTime : undefined
                  }
                  displayRiskMap={displayRiskMap}
                  focusHitFor={focusHitFor}
                  onSeek={onSeek}
                  onWordClick={onWordClick}
                  onToggleVerify={onToggleVerify}
                  showVerify={showVerifyControls}
                  textOverride={segmentTextEdits?.[segment.id]?.text}
                  onEditSentence={onEditSentence}
                  onMergeNext={onMergeNext}
                  onSplitDraft={onSplitDraft}
                  canMergeNext={
                    transcript.segments[transcript.segments.length - 1]?.id !== segment.id
                  }
                  onChangeSpeaker={onChangeSpeaker}
                  editMode={editMode}
                  showChanges={showChanges}
                  editLabel={
                    editInfo?.[segment.id]
                      ? `${editInfo[segment.id].reviewer} · ${editInfo[segment.id].time}`
                      : undefined
                  }
                />
              </div>
              )
            })
          )}
        </div>

        <p className="mt-8 pt-4 border-t border-border text-[11px] text-ink-faint italic">
          {showVerifyControls
            ? 'End of transcript. All changes are recorded in the audit trail.'
            : 'End of transcript. Your edits are saved automatically.'}
        </p>
      </div>
    </main>
  )
}
