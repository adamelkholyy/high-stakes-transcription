import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelName, Segment } from '../types'

export interface PopupAnchor {
  segId: number
  wordIdx: number
  rect: DOMRect
}

interface Props {
  anchor: PopupAnchor
  segment: Segment
  availableModels: ModelName[]
  activeModel: ModelName
  currentText: string
  isDeleted: boolean
  // How many tokens currently display the same text (this one included). When
  // > 1, the popup offers a one-click "apply to all" batch correction.
  sameTokenCount?: number
  onApply: (newText: string, reason?: string) => void
  onApplyAll?: (newText: string, reason: string | undefined, via: 'candidate' | 'manual') => void
  onDelete: (reason?: string) => void
  onClose: () => void
  // #2: split this segment so that this word starts a new segment.
  onSplit?: () => void
  // Seek to this word's timestamp and play (only when the word carries a start).
  onPlayFromWord?: (segId: number, wordIdx: number) => void
}

export default function CandidatePopup({
  anchor,
  segment,
  availableModels,
  activeModel,
  currentText,
  isDeleted,
  sameTokenCount = 0,
  onApply,
  onApplyAll,
  onDelete,
  onClose,
  onSplit,
  onPlayFromWord,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [manual, setManual] = useState('')
  const [reason, setReason] = useState('')
  const [applyAll, setApplyAll] = useState(false)
  const canApplyAll = !isDeleted && !!onApplyAll && sameTokenCount > 1
  // "Play from here" only when this word (in the active model) has a real start.
  const canPlayFromWord =
    !isDeleted && !!onPlayFromWord && segment.words[activeModel]?.[anchor.wordIdx]?.start != null

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const candidates = useMemo(() => {
    const out: { text: string; models: ModelName[] }[] = []
    for (const m of availableModels) {
      const word = segment.words[m]?.[anchor.wordIdx]
      if (!word) continue
      const text = word.text
      if (!text) continue
      const existing = out.find((c) => c.text === text)
      if (existing) existing.models.push(m)
      else out.push({ text, models: [m] })
    }
    return out
  }, [availableModels, segment, anchor.wordIdx])

  const submitReason = () => (reason.trim() ? reason.trim() : undefined)

  const doApply = (text: string, via: 'candidate' | 'manual') => {
    if (applyAll && canApplyAll) onApplyAll!(text, submitReason(), via)
    else onApply(text, submitReason())
  }

  const top = anchor.rect.bottom + 6
  const left = Math.min(anchor.rect.left, window.innerWidth - 300)

  return (
    <div
      ref={ref}
      style={{ position: 'fixed', top, left, width: 280, zIndex: 50 }}
      className="bg-surface border border-border-strong rounded-md shadow-lg p-3 text-sm"
      data-tour="popup"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <p className="text-[11px] font-medium text-ink-faint">
            {isDeleted ? 'Restore word' : 'Word candidates'}
          </p>
          {/* Seek to this word's timestamp and play — sits right by the title. */}
          {canPlayFromWord && (
            <button
              onClick={() => onPlayFromWord!(anchor.segId, anchor.wordIdx)}
              title="Play from this word"
              aria-label="Play from this word"
              className="flex items-center justify-center w-5 h-5 rounded-full border border-border text-ink-muted hover:text-brand hover:border-brand transition-colors"
            >
              <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
                <polygon points="2,1 11,6 2,11" />
              </svg>
            </button>
          )}
        </div>
        <p className="font-mono text-[10px] text-ink-faint">
          seg {anchor.segId} · #{anchor.wordIdx + 1}
        </p>
      </div>

      <ul className="space-y-1 mb-2">
        {candidates.map((c) => {
          const isCurrent = !isDeleted && c.text === currentText
          return (
            <li key={c.text}>
              <button
                onClick={() => doApply(c.text, 'candidate')}
                className={[
                  'w-full text-left px-2 py-1.5 rounded border transition-colors',
                  isCurrent
                    ? 'border-ink-muted bg-surface-muted'
                    : 'border-border hover:bg-surface-muted',
                ].join(' ')}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-ink">{c.text}</span>
                  <span className="text-[10px] text-ink-faint">
                    {c.models.map((m) => m.replace(/\s*\(.*\)/, '')).join(', ')}
                  </span>
                </div>
              </button>
            </li>
          )
        })}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          const v = manual.trim()
          if (v) doApply(v, 'manual')
        }}
        className="border-t border-border pt-2 flex gap-1 mb-2"
      >
        <input
          autoFocus
          type="text"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Manual correction…"
          className="flex-1 text-xs border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-border-strong"
        />
        <button
          type="submit"
          disabled={!manual.trim()}
          className="text-xs px-2 py-1 rounded bg-brand text-white hover:bg-brand-dark disabled:opacity-40"
        >
          Apply
        </button>
      </form>

      {/* Reason note — shared by Apply and Delete. */}
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder='Reason (optional, e.g. "not in audio")'
        className="w-full text-xs border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-border-strong mb-2"
      />

      {/* Batch correct-all: one decision fixes every identical token. */}
      {canApplyAll && (
        <label className="flex items-center gap-2 mb-2 text-[11px] text-ink-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={applyAll}
            onChange={(e) => setApplyAll(e.target.checked)}
            className="accent-brand w-3.5 h-3.5"
          />
          <span>
            Apply to all <span className="font-medium text-ink">{sameTokenCount}</span>{' '}
            <span className="font-mono">“{currentText}”</span>
          </span>
        </label>
      )}

      {/* Delete / hallucination */}
      {!isDeleted && (
        <button
          onClick={() => onDelete(submitReason())}
          className="w-full flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded border border-risk-high/40 text-risk-high hover:bg-risk-high-bg transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 2l6 6M8 2l-6 6" strokeLinecap="round" />
          </svg>
          Delete (hallucination)
        </button>
      )}
      {isDeleted && (
        <p className="text-[10px] text-ink-faint italic text-center">
          Currently marked as deleted. Pick a candidate or type a correction to restore.
        </p>
      )}

      {/* Split the segment so this word begins a new segment. */}
      {!isDeleted && onSplit && anchor.wordIdx > 0 && (
        <button
          onClick={onSplit}
          title="Start a new segment at this word"
          className="mt-2 w-full flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded border border-border text-ink-muted hover:text-ink hover:border-ink-muted transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M6 1.5v9M3.5 4 6 1.5 8.5 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Split segment before this word
        </button>
      )}

      <div className="mt-2 flex items-center justify-between">
        <p className="text-[10px] text-ink-faint italic">
          Active model: {activeModel.replace(/\s*\(.*\)/, '')}
        </p>
        <a
          href="/guide.html"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-brand hover:underline"
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
  )
}
