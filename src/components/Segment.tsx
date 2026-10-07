import { useEffect, useMemo, useRef, useState } from 'react'
import type { AlignedToken, EditMode, EditState, FocusWordHit, HighlightLayer, ModelName, Risk, Segment as SegmentType } from '../types'
import Word from './Word'
import { alignRewrite } from '../lib/retainRisk'

interface Props {
  segment: SegmentType
  model: ModelName
  active: boolean
  verified: boolean
  edits: Record<string, EditState>
  dimension: HighlightLayer
  // Progressive disclosure: when collapsed, the sentence shows only a head risk
  // dot (+ a quiet HIGH underline); clicking it expands to full word-level risk.
  expanded: boolean
  onToggleExpand: (segId: number) => void
  // Single-click the sentence body → seek there + play it (and pin it open).
  onPlaySegment?: (segId: number) => void
  // Hover-reveal: transiently show this segment's word-level risk while hovered.
  onHover?: (segId: number | null) => void
  // Policy-aware segment risk, computed once in TranscriptView (riskOf). Drives
  // the sentence-head dot — reused here, never recomputed.
  segmentRisk: Risk
  /** Hide the segment-head risk dot. Sentence builds: the whole-sentence
   *  highlighter already conveys the signal, so the dot is redundant. */
  hideRiskDot?: boolean
  /** Sentence builds: highlighter-mark the WHOLE sentence at this level
   *  ('high' = red tint, 'med' = amber tint). Source is importance (LLM triage)
   *  or uncertainty (paraRisk) depending on the version. undefined = no tint. */
  sentenceTint?: Risk
  /** Sentence builds: tooltip on the highlighted sentence (rank·reason, or
   *  the confidence level). */
  sentenceTintTitle?: string
  // Soft vs pure collapsed look — threaded straight to Word.
  collapsedHighUnderline: boolean
  // Word-highlight level ('all' | 'high') — 'high' hides MED highlights.
  highlightLevel?: 'all' | 'high'
  // Karaoke: index of the word currently being spoken in THIS segment, or null.
  // Only the active (playing) segment ever receives a non-null value.
  activeWordIndex?: number | null
  // Karaoke for REWRITTEN segments: the playhead time, passed only to the active
  // segment. The override branch scans the aligned tokens' start/end with it
  // (the normal branch uses activeWordIndex). undefined elsewhere.
  activeTime?: number
  // Per-word display-risk override for the combined dimension. null means
  // Word falls back to its source combined_risk.
  displayRiskMap?: Map<string, Risk> | null
  // Focus mode (2b): per-word focus marker lookup. No-op when focus is inactive.
  focusHitFor?: (segId: number, wordIdx: number) => FocusWordHit | undefined
  onSeek: (seconds: number) => void
  onWordClick: (segId: number, wordIdx: number, rect: DOMRect) => void
  // Single toggle; shift-click verifies the range from the last-clicked segment.
  onToggleVerify: (segId: number, opts?: { range?: boolean }) => void
  /** Hide reviewer-facing verification while edit/audit capture keeps running. */
  showVerify?: boolean
  // #1 whole-sentence edit. When textOverride is set, the segment is rendered as
  // one rewritten block (per-word highlighting is dropped).
  textOverride?: string
  onEditSentence?: (segId: number, text: string) => void
  /** 'document' = "edit like Word": click the sentence and type inline, blur/
   *  Enter saves, no word popup. 'assisted' (default) = the current flow. */
  editMode?: EditMode
  // #2 structural edits.
  onMergeNext?: (segId: number) => void
  canMergeNext?: boolean
  /** "Split here" inside the line editor — draft halves cut at the cursor. */
  onSplitDraft?: (segId: number, textA: string, textB: string) => void
  onChangeSpeaker?: (segId: number, speaker: string) => void
  // Track-changes view (threaded to each Word). Default on.
  showChanges?: boolean
  // "<reviewer> · <hh:mm>" of the latest change in this segment, if any.
  editLabel?: string
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Known speaker labels get themed colours; anything else (e.g. "Speaker"
// from a non-diarized Whisper pipeline) falls through to neutral ink.
const SPEAKER_COLOR: Record<string, string> = {
  Officer: 'text-speaker-officer',
  Witness: 'text-speaker-witness',
}
const SPEAKER_COLOR_DEFAULT = 'text-ink'

// Segment-head high-risk dot: disabled 2026-07-08 (user preference — the word
// highlights already show where the risk is, so the dot felt redundant). Flip
// to true to bring it back.
const SHOW_SEGMENT_RISK_DOT = false

export default function Segment({
  segment,
  model,
  active,
  verified,
  edits,
  dimension,
  expanded,
  onToggleExpand,
  onPlaySegment,
  onHover,
  segmentRisk,
  hideRiskDot = false,
  sentenceTint,
  sentenceTintTitle,
  collapsedHighUnderline,
  highlightLevel = 'all',
  activeWordIndex,
  activeTime,
  displayRiskMap,
  focusHitFor,
  onSeek,
  onWordClick,
  onToggleVerify,
  showVerify = true,
  textOverride,
  onEditSentence,
  editMode = 'assisted',
  onMergeNext,
  canMergeNext = false,
  onSplitDraft,
  onChangeSpeaker,
  showChanges = true,
  editLabel,
}: Props) {
  const words = segment.words[model] ?? []

  // Has the reviewer changed anything in this segment? Drives the change-bar
  // + "edited" tag so a touched segment is obvious at a glance.
  const hasEdits =
    textOverride != null || words.some((_, i) => edits[`${segment.id}-${i}`] !== undefined)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Cursor access for "Split here" — where in the draft the cut lands.
  const editTaRef = useRef<HTMLTextAreaElement | null>(null)
  const [editingSpeaker, setEditingSpeaker] = useState(false)
  const [speakerDraft, setSpeakerDraft] = useState('')

  // Single-click = play this segment; double-click = edit it. Defer the
  // single-click so a double-click can cancel it (no stray play + edit).
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current) }, [])

  // Word-level diff of a whole-sentence rewrite (pure + memoized — recomputes
  // only when the override text or original words change, NOT per karaoke tick).
  const aligned = useMemo(
    () => (textOverride != null ? alignRewrite(textOverride, words, segment.start, segment.end) : null),
    [textOverride, words, segment.start, segment.end],
  )
  // Group consecutive same-blockId inserts into one render unit (a clause block).
  type RewriteGroup =
    | { type: 'word'; tok: AlignedToken; key: number }
    | { type: 'insert'; tok: AlignedToken; key: number }
    | { type: 'block'; toks: AlignedToken[]; start?: number; end?: number; key: number }
  const groups = useMemo<RewriteGroup[] | null>(() => {
    if (!aligned) return null
    const g: RewriteGroup[] = []
    for (let i = 0; i < aligned.length; ) {
      const t = aligned[i]
      if (t.op === 'keep') {
        g.push({ type: 'word', tok: t, key: i })
        i++
      } else if (t.blockId != null) {
        const id = t.blockId
        const startI = i
        while (i < aligned.length && aligned[i].blockId === id) i++
        g.push({ type: 'block', toks: aligned.slice(startI, i), start: t.start, end: t.end, key: startI })
      } else {
        g.push({ type: 'insert', tok: t, key: i })
        i++
      }
    }
    return g
  }, [aligned])
  const tokActive = (start?: number, end?: number) =>
    activeTime != null && start != null && end != null && activeTime >= start && activeTime < end

  // Current rendered sentence (edits applied, deletions dropped) — prefill for
  // the whole-sentence editor.
  const fullText =
    textOverride ??
    words
      .map((w, i) => {
        const e = edits[`${segment.id}-${i}`]
        if (e?.deleted) return ''
        return e ? e.text : w.text
      })
      .filter(Boolean)
      .join(' ')

  // No left bar, no segment-level "HIGH RISK" badge — segment risk is conveyed
  // purely by the coloured words (so red lands on the words that matter, not the
  // whole segment). active/verified keep just a faint background tint.
  const containerCls = verified
    ? 'bg-verified-bg/50 ring-1 ring-verified-bar/30'
    : active
    ? 'bg-brand-active/50 ring-1 ring-brand/25'
    : 'hover:bg-surface-muted hover:ring-1 hover:ring-border'

  const startEdit = () => {
    setDraft(fullText)
    setEditing(true)
  }
  const commitEdit = () => {
    const v = draft.trim()
    // Only record a real change. A no-op save — or a click-away (blur) with
    // nothing actually edited — just closes the editor and must NOT mark the
    // segment as edited.
    if (v && v !== fullText) onEditSentence?.(segment.id, v)
    setEditing(false)
  }
  const commitSpeaker = () => {
    const v = speakerDraft.trim()
    if (v && v !== segment.speaker) onChangeSpeaker?.(segment.id, v)
    setEditingSpeaker(false)
  }

  // "Edit like Word" mode: clicking a word (or anywhere in the sentence) opens
  // the inline whole-sentence editor instead of the per-word candidate popup.
  const documentMode = editMode === 'document'
  const handleWordClick: Props['onWordClick'] = documentMode
    ? () => startEdit()
    : onWordClick

  // Click anywhere on the segment card to play it; double-click to edit the
  // whole sentence. Single-click is deferred so a double-click can cancel it.
  // Interactive controls (header buttons, expanded words, the editor) all
  // stopPropagation, so only the blank areas of the card trigger these — which
  // is why the handler lives on the <article> (covers the header row too, not
  // just the sentence body).
  const playSegment = () => {
    if (editing || editingSpeaker) return
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      onPlaySegment?.(segment.id)
    }, 250)
  }
  const editSegment = () => {
    if (editing) return
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    startEdit()
  }

  // Whole-sentence highlighter (sentence builds): a coloured left rail + a soft
  // tint that fades out to the right, rather than a full-width solid block (the
  // old look read as a heavy bar). The tint fades to the same hue at 0 alpha
  // (not `transparent`) so there's no grey fringe mid-fade. The sentence-level
  // layer sits ON TOP of any word-level marks; reviewer edits keep their own
  // (green) treatment and the tint yields to it (see the rewrite branch below).
  const sentenceCls =
    sentenceTint === 'high'
      ? 'text-[15px] leading-[1.6] text-ink border-l-[3px] border-risk-high/70 bg-gradient-to-r from-risk-high-bg/80 to-risk-high-bg/0 rounded-r-sm pl-2.5 pr-2 py-0.5 -ml-2.5'
      : sentenceTint === 'med'
        ? 'text-[15px] leading-[1.6] text-ink border-l-[3px] border-risk-med/70 bg-gradient-to-r from-risk-med-bg/80 to-risk-med-bg/0 rounded-r-sm pl-2.5 pr-2 py-0.5 -ml-2.5'
        : 'text-[15px] leading-[1.6] text-ink'

  return (
    <article
      onMouseEnter={() => onHover?.(segment.id)}
      onMouseLeave={() => onHover?.(null)}
      onClick={playSegment}
      onDoubleClick={(e) => {
        e.preventDefault()
        editSegment()
      }}
      title="Click to play this segment · double-click to edit"
      className={`group flex gap-3 rounded-md transition-colors px-3 py-1 -mx-3 cursor-pointer ${containerCls}`}
    >
      <div className="flex-1 min-w-0">
        <header className="flex items-center gap-3 mb-0.5">
          {/* Expand affordance + sentence-head risk dot (the sentence-level
              signal that replaces always-on word colour). */}
          <span className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand(segment.id)
              }}
              title={expanded ? 'Collapse — hide word-level risk' : 'Show word-level risk'}
              aria-expanded={expanded}
              className="text-ink-faint hover:text-ink p-0.5 -ml-1 rounded hover:bg-surface-muted transition-colors"
            >
              <svg
                className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M4.5 3l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {/* Only HIGH risk gets a head dot; medium shows nothing (just the
                chevron). Keeps the overview quiet — red means "look here".
                Hidden in the sentence build (the sentence tint says it). */}
            {SHOW_SEGMENT_RISK_DOT && !hideRiskDot && segmentRisk === 'high' && (
              <span
                aria-hidden="true"
                title="High risk"
                className="w-2 h-2 rounded-full bg-risk-high"
              />
            )}
          </span>
          {editingSpeaker ? (
            <input
              autoFocus
              value={speakerDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setSpeakerDraft(e.target.value)}
              onBlur={commitSpeaker}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSpeaker()
                if (e.key === 'Escape') setEditingSpeaker(false)
              }}
              placeholder="Speaker…"
              className="text-[11px] uppercase tracking-wide border border-border rounded px-1.5 py-0.5 w-28 focus:outline-none focus:ring-1 focus:ring-border-strong"
            />
          ) : (
            <span
              onClick={
                onChangeSpeaker
                  ? (e) => {
                      e.stopPropagation()
                      setSpeakerDraft(segment.speaker)
                      setEditingSpeaker(true)
                    }
                  : undefined
              }
              title={onChangeSpeaker ? 'Click to change speaker' : undefined}
              className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${
                SPEAKER_COLOR[segment.speaker] ?? SPEAKER_COLOR_DEFAULT
              } ${onChangeSpeaker ? 'cursor-pointer hover:underline decoration-dotted underline-offset-2' : ''}`}
            >
              {segment.speaker}
            </span>
          )}
          {/* Seek lives on the timestamp now (the sentence body click expands
              instead of seeking). */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSeek(segment.start)
            }}
            title="Play from here"
            className="font-mono text-[11px] text-ink-faint tabular-nums hover:text-brand transition-colors"
          >
            {formatTime(segment.start)}
          </button>

          {active && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-brand">
              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-brand" />
              Playing
            </span>
          )}

          {hasEdits && (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-change-ins bg-change-ins-bg rounded-full px-1.5 py-0.5 leading-none"
              title="Reviewer-edited segment"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M8.5 1.5 10.5 3.5 4 10 1.5 10.5 2 8z" strokeLinejoin="round" />
              </svg>
              edited{editLabel ? ` · ${editLabel}` : ''}
            </span>
          )}

          <span className="ml-auto flex items-center gap-1">
            {/* Edit a whole sentence — high-frequency, so it's always visible
                (but quiet). Merge is rarer, so it only appears on hover. */}
            {onEditSentence && !editing && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  startEdit()
                }}
                title="Edit the whole sentence"
                className="text-ink-muted hover:text-ink p-1 rounded hover:bg-surface-muted transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M8.5 1.5 10.5 3.5 4 10 1.5 10.5 2 8z" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            {onMergeNext && canMergeNext && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onMergeNext(segment.id)
                }}
                title="Merge with the next segment"
                className="text-ink-faint hover:text-ink p-1 rounded hover:bg-surface-muted opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M6 1.5V7M3.5 4.5 6 7l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M2 10h8" strokeLinecap="round" />
                </svg>
              </button>
            )}
            {/* Verify — kept quiet by default (a column of solid buttons drowns
                the transcript); it goes solid navy only on the segment you're
                on or hovering. Verified is a calm green. */}
            {showVerify && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleVerify(segment.id, { range: e.shiftKey })
                }}
                title="Mark this segment checked. Shift-click to verify a range."
                className={[
                  'text-[11px] font-medium px-2.5 py-1 rounded transition-colors',
                  verified
                    ? 'border border-verified/40 text-verified bg-verified-bg/60'
                    : active
                    ? 'bg-brand text-white hover:bg-brand-dark shadow-sm'
                    : 'border border-transparent text-ink-faint group-hover:border-border group-hover:text-ink-muted hover:!border-brand hover:!text-brand',
                ].join(' ')}
              >
                {verified ? '✓ Verified' : 'Verify'}
              </button>
            )}
          </span>
        </header>

        {editing ? (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea
              ref={editTaRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={
                documentMode
                  ? (e) => {
                      // Caret to end (Word-like): click into the text and type.
                      const v = e.currentTarget.value
                      e.currentTarget.setSelectionRange(v.length, v.length)
                    }
                  : undefined
              }
              // Click-away = auto-handle: commitEdit saves when the text
              // actually changed, otherwise just closes (like Cancel). The
              // Save/Cancel buttons preventDefault on mousedown so they don't
              // trip this blur first (which would let Cancel wrongly save).
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(false)
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                  // Enter saves in both editor modes (transcript lines are
                  // single sentences); Shift+Enter keeps the newline and
                  // Cmd/Ctrl+Enter always saves.
                  e.preventDefault()
                  commitEdit()
                }
              }}
              rows={documentMode ? Math.min(8, Math.max(2, Math.ceil((draft.length + 1) / 70))) : 3}
              className={
                documentMode
                  ? 'w-full text-[15px] leading-[1.6] text-ink bg-brand-active/20 rounded px-1.5 py-0.5 -mx-1.5 border border-brand/30 resize-none focus:outline-none focus:ring-1 focus:ring-brand/40'
                  : 'w-full text-[14px] leading-snug border border-border rounded px-2 py-1.5 resize-y focus:outline-none focus:ring-1 focus:ring-border-strong'
              }
            />
            <div className="mt-1.5 flex items-center gap-2">
              {documentMode ? (
                <span className="text-[10px] text-ink-faint italic">
                  Type to edit · Enter to save · Esc to cancel
                </span>
              ) : (
                <>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={commitEdit}
                    disabled={!draft.trim()}
                    className="text-xs px-2.5 py-1 rounded bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
                  >
                    Save
                  </button>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setEditing(false)}
                    className="text-xs px-2.5 py-1 rounded border border-border text-ink-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                  {onSplitDraft && words.length >= 2 && (
                    // Split without leaving the editor:
                    // the text after the cursor becomes a new segment, and the
                    // draft halves are saved onto the two segments.
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const ta = editTaRef.current
                        if (!ta) return
                        const cur = ta.selectionStart ?? 0
                        const a = draft.slice(0, cur).trim()
                        const b = draft.slice(cur).trim()
                        if (!a || !b) return // cursor at an edge — nothing to split
                        setEditing(false)
                        onSplitDraft(segment.id, a, b)
                      }}
                      title="Split into two segments at the cursor — the text after the cursor starts the new segment (edits are kept)"
                      className="text-xs px-2.5 py-1 rounded border border-border text-ink-muted hover:text-ink hover:border-border-strong"
                    >
                      Split here
                    </button>
                  )}
                  <span className="text-[10px] text-ink-faint italic">
                    Rewriting the sentence drops per-word risk highlighting for this segment.
                  </span>
                </>
              )}
              {/* Help link from the editing view (police feedback). */}
              <a
                href="/guide.html"
                target="_blank"
                rel="noopener noreferrer"
                onMouseDown={(e) => e.preventDefault()}
                className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-[10px] text-brand hover:underline"
                title="Open the reviewer guide"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <circle cx="6" cy="6" r="5" />
                  <path d="M4.7 4.6a1.4 1.4 0 1 1 1.8 1.3c-.4.2-.5.4-.5.8M6 8.7v.01" strokeLinecap="round" />
                </svg>
                Help
              </a>
            </div>
          </div>
        ) : (
          // Play / edit is handled on the whole card (<article>); this stays the
          // keyboard target (Enter/Space play). Word clicks (when expanded) and
          // header controls stopPropagation; collapsed word clicks bubble up so
          // the sentence reveals word-level risk + plays. Chevron = expand only.
          <div
            role="button"
            aria-expanded={expanded}
            tabIndex={0}
            // Document mode: a single click anywhere in the sentence opens the
            // inline editor (and doesn't bubble to the card's play handler).
            onClick={
              documentMode
                ? (e) => {
                    e.stopPropagation()
                    startEdit()
                  }
                : undefined
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (documentMode) startEdit()
                else onPlaySegment?.(segment.id)
              }
            }}
            className={documentMode ? 'cursor-text' : undefined}
          >
            {textOverride != null && groups ? (
              // Rewritten sentence: word-level diff against the original words.
              // 'keep' tokens render via <Word> (inherit real risk + karaoke);
              // inserted words/clauses render in the blue "inserted" style — a
              // clause run is one block that karaokes together.
              <p
                title={sentenceTint ? sentenceTintTitle : undefined}
                className={
                  showChanges
                    ? 'text-[15px] leading-[1.6] text-ink bg-change-ins-bg rounded px-1.5 py-0.5 -mx-1 ring-1 ring-change-ins/25'
                    : sentenceCls
                }
              >
                {groups.map((g, gi) => (
                  <span key={g.key}>
                    {g.type === 'word' ? (
                      <Word
                        word={g.tok.word!}
                        displayText={g.tok.text}
                        edited={false}
                        deleted={false}
                        dimension={dimension}
                        expanded={expanded}
                        collapsedHighUnderline={collapsedHighUnderline}
                        highlightLevel={highlightLevel}
                        isActiveWord={expanded && tokActive(g.tok.start, g.tok.end)}
                        displayRisk={
                          dimension === 'combined'
                            ? displayRiskMap?.get(`${segment.id}-${g.tok.originalIndex}`)
                            : undefined
                        }
                        showChanges={false}
                        segId={segment.id}
                        wordIdx={g.tok.originalIndex ?? 0}
                        onWordClick={handleWordClick}
                      />
                    ) : (
                      <span
                        title="Inserted by reviewer"
                        className={`text-change-ins underline decoration-change-ins/60 decoration-2 underline-offset-[3px] rounded-sm px-0.5 ${
                          (g.type === 'block' ? tokActive(g.start, g.end) : tokActive(g.tok.start, g.tok.end))
                            ? 'bg-brand-active ring-1 ring-brand/40'
                            : ''
                        }`}
                      >
                        {g.type === 'block' ? g.toks.map((t) => t.text).join(' ') : g.tok.text}
                      </span>
                    )}
                    {gi < groups.length - 1 ? ' ' : ''}
                  </span>
                ))}
                {showChanges && (
                  <span className="ml-2 align-middle font-sans text-[10px] font-medium text-change-ins">
                    rewritten
                  </span>
                )}
              </p>
            ) : (
              <p title={sentenceTint ? sentenceTintTitle : undefined} className={sentenceCls}>
                {words.map((word, i) => {
                  const key = `${segment.id}-${i}`
                  const edit = edits[key]
                  const displayText = edit ? edit.text : word.text
                  return (
                    <span key={i}>
                      <Word
                        word={word}
                        displayText={displayText}
                        edited={edit !== undefined && !edit.deleted}
                        deleted={edit?.deleted === true}
                        dimension={dimension}
                        expanded={expanded}
                        collapsedHighUnderline={collapsedHighUnderline}
                        highlightLevel={highlightLevel}
                        isActiveWord={expanded && i === activeWordIndex}
                        displayRisk={
                          dimension === 'combined'
                            ? displayRiskMap?.get(`${segment.id}-${i}`)
                            : undefined
                        }
                        focusHit={focusHitFor?.(segment.id, i)}
                        showChanges={showChanges}
                        segId={segment.id}
                        wordIdx={i}
                        onWordClick={handleWordClick}
                      />
                      {i < words.length - 1 ? ' ' : ''}
                    </span>
                  )
                })}
              </p>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
