import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OutlineChapter, OutlinePart, OutlineResult } from '../types'
import { findCurrentId, fmtDuration, match, mmss } from '../lib/outlineUtils'

interface Props {
  result: OutlineResult | null
  running: boolean
  error?: string | null
  /** Total recording length, shown in the header. */
  audioDuration: number
  /** Drives the "you are here" glow on the current Part card. */
  currentTime: number
  onRegenerate: () => void
  onClose: () => void
  /** Jump to a Part / Chapter (seeks the audio; the parent closes this view). */
  onPartClick: (part: OutlinePart) => void
  onChapterClick: (chapter: OutlineChapter) => void
  /** Switch to the compact docked side panel. */
  onDock: () => void
}

// ---------------------------------------------------------------------------
// Full-screen Outline STORYBOARD: the recording as a chain of story-beat cards.
// Cards read in snake order (left→right, then right→left on the next row) and
// are linked by an animated SVG connector path, so the whole recording scans
// like a storyline. Clicking a card opens a chapter drawer; the explicit jump
// affordances (not the card itself) seek the audio — that distinction keeps the
// outline_part_click / outline_chapter_click events meaning "seek", unchanged.
//
// Motion lives ONLY here (SPEC keeps the rest of the tool static) and is
// applied via motion-safe: variants, so prefers-reduced-motion users get a
// complete, static storyboard.
// ---------------------------------------------------------------------------

/** Cards per row: 3 on wide screens, 2 on tablets, 1 on narrow windows. */
function useColumns(): number {
  const get = () =>
    typeof window === 'undefined' || window.matchMedia('(min-width: 1280px)').matches
      ? 3
      : window.matchMedia('(min-width: 768px)').matches
      ? 2
      : 1
  const [cols, setCols] = useState<number>(get)
  useEffect(() => {
    const onResize = () => setCols(get())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return cols
}

export default function OutlineStoryboard({
  result,
  running,
  error,
  audioDuration,
  currentTime,
  onRegenerate,
  onClose,
  onPartClick,
  onChapterClick,
  onDock,
}: Props) {
  const [filter, setFilter] = useState('')
  const [detailPart, setDetailPart] = useState<OutlinePart | null>(null)

  // Memoized so effect deps stay stable while result is null (a fresh [] every
  // render would re-run the connector effect in a setState loop).
  const parts = useMemo(() => result?.parts ?? [], [result])
  const hasParts = parts.length > 0
  const cols = useColumns()

  const currentPartId = useMemo(() => findCurrentId(parts, currentTime), [parts, currentTime])
  const currentChapterId = useMemo(() => {
    const all = parts.flatMap((p) => p.chapters)
    return findCurrentId(all, currentTime)
  }, [parts, currentTime])

  // Esc: close the drawer first, then the storyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (detailPart) setDetailPart(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailPart, onClose])

  // Filter DIMS non-matching cards instead of removing them, so the snake
  // geometry (and the connector path) stays stable while filtering.
  const q = filter.trim().toLowerCase()
  const matchedIds = useMemo(() => {
    if (!q) return null
    const ids = new Set<number>()
    for (const p of parts) {
      if (
        match(p.title, q) ||
        match(p.description, q) ||
        p.chapters.some((c) => match(c.title, q) || match(c.gist, q))
      )
        ids.add(p.id)
    }
    return ids
  }, [parts, q])

  // Snake layout: chunk parts into rows; odd rows render reversed so reading
  // order flows left→right, then right→left — DOM order stays chronological.
  const rows = useMemo(() => {
    const out: OutlinePart[][] = []
    for (let i = 0; i < parts.length; i += cols) out.push(parts.slice(i, i + cols))
    return out
  }, [parts, cols])

  // ---- SVG connectors ------------------------------------------------------
  const gridRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef(new Map<number, HTMLDivElement>())
  const registerCard = useCallback((id: number, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(id, el)
    else cardRefs.current.delete(id)
  }, [])
  const [links, setLinks] = useState<string[]>([])

  const recomputeLinks = useCallback(() => {
    const grid = gridRef.current
    if (!grid || parts.length < 2) {
      setLinks((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const g = grid.getBoundingClientRect()
    const ds: string[] = []
    for (let i = 0; i < parts.length - 1; i++) {
      const a = cardRefs.current.get(parts[i].id)
      const b = cardRefs.current.get(parts[i + 1].id)
      if (!a || !b) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const rel = (r: DOMRect) => ({
        left: r.left - g.left,
        right: r.right - g.left,
        top: r.top - g.top,
        bottom: r.bottom - g.top,
        cx: r.left - g.left + r.width / 2,
        cy: r.top - g.top + r.height / 2,
      })
      const A = rel(ra)
      const B = rel(rb)
      if (Math.floor(i / cols) === Math.floor((i + 1) / cols)) {
        // Same row: connect the facing edges (mirrored on reversed rows).
        const bIsRight = B.cx >= A.cx
        const sx = bIsRight ? A.right : A.left
        const ex = bIsRight ? B.left : B.right
        const dx = (ex - sx) / 2
        ds.push(`M ${sx} ${A.cy} C ${sx + dx} ${A.cy}, ${ex - dx} ${B.cy}, ${ex} ${B.cy}`)
      } else {
        // Row turn: drop from the bottom of one card to the top of the next.
        const dy = (B.top - A.bottom) / 2
        ds.push(
          `M ${A.cx} ${A.bottom} C ${A.cx} ${A.bottom + dy}, ${B.cx} ${B.top - dy}, ${B.cx} ${B.top}`,
        )
      }
    }
    setLinks(ds)
  }, [parts, cols])

  // Recompute whenever layout can change: parts/columns, grid resize, window
  // resize (also catches browser zoom). The drawer never moves the grid, so
  // opening it does not invalidate the path.
  useLayoutEffect(() => {
    recomputeLinks()
  }, [recomputeLinks, hasParts])
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const ro = new ResizeObserver(() => recomputeLinks())
    ro.observe(grid)
    window.addEventListener('resize', recomputeLinks)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', recomputeLinks)
    }
  }, [recomputeLinks])

  const cardDelay = (i: number) => `${i * 45}ms`
  const linkDelay = (i: number) => `${parts.length * 45 + 300 + i * 90}ms`

  return (
    <div
      className="fixed inset-0 z-50 bg-surface-muted flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Recording storyboard"
    >
      {/* Header */}
      <header className="shrink-0 h-14 px-6 bg-surface border-b border-border flex items-center gap-3">
        <h2 className="text-sm font-semibold text-brand uppercase tracking-[0.1em] shrink-0">
          Outline
        </h2>
        {audioDuration > 0 && (
          <span className="text-[11px] font-mono text-ink-faint tabular-nums shrink-0">
            {fmtDuration(audioDuration)} recording
          </span>
        )}
        {hasParts && (
          <span className="text-[11px] text-ink-faint shrink-0">
            · {parts.length} {parts.length === 1 ? 'part' : 'parts'}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {hasParts && (
            <>
              {matchedIds && (
                <span className="text-[11px] text-ink-faint tabular-nums">
                  {matchedIds.size} of {parts.length} match
                </span>
              )}
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter parts…"
                className="w-56 text-[12px] border border-border rounded-md px-2.5 py-1.5 bg-surface placeholder:text-ink-faint/60 focus:outline-none focus:ring-1 focus:ring-brand/50 focus:border-brand/50"
              />
              <button
                onClick={onRegenerate}
                disabled={running}
                className="text-[11px] px-2 py-1.5 rounded-md border border-border text-ink-muted hover:border-ink-muted hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Re-run the local model over the transcript"
              >
                {running ? 'Generating…' : 'Regenerate'}
              </button>
            </>
          )}
          <button
            onClick={onDock}
            aria-label="Dock beside the transcript"
            title="Dock beside the transcript"
            className="w-8 h-8 flex items-center justify-center rounded-md text-ink-muted hover:text-brand hover:bg-surface-muted transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
              <rect x="1.5" y="2.5" width="4" height="9" rx="1.5" fill="currentColor" stroke="none" opacity="0.5" />
            </svg>
          </button>
          <button
            onClick={onClose}
            aria-label="Close storyboard"
            className="w-8 h-8 flex items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-surface-muted transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2.5 2.5l8 8M10.5 2.5l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {error ? (
          <div className="h-full flex items-center justify-center px-6">
            <div className="max-w-md rounded-lg border border-risk-med/30 bg-risk-med-bg px-5 py-4">
              <p className="text-[13px] font-semibold text-risk-med">Outline needs the local model</p>
              <p className="mt-1.5 text-[12px] text-ink-muted leading-snug break-words">{error}</p>
              <p className="mt-2 text-[11px] text-ink-faint leading-snug">
                Outline runs on a local service at port 8000 — make sure it's running, then
                Regenerate.
              </p>
              <button
                onClick={onRegenerate}
                disabled={running}
                className="mt-3 text-[12px] px-3 py-1.5 rounded-md border border-border bg-surface text-ink-muted hover:text-ink hover:border-ink-muted transition-colors disabled:opacity-40"
              >
                {running ? 'Generating…' : 'Regenerate'}
              </button>
            </div>
          </div>
        ) : running && !hasParts ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-ink-faint">
            <span className="inline-block w-7 h-7 rounded-full border-2 border-brand/60 border-t-transparent animate-spin" />
            <p className="text-[13px]">Reading the transcript…</p>
            <p className="text-[11px] text-ink-faint/80">
              A local model is chaptering the recording — nothing is uploaded.
            </p>
          </div>
        ) : !hasParts ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-[13px] text-ink-faint italic">
              No outline yet. Generate one to see the recording as a storyboard.
            </p>
          </div>
        ) : (
          <div className="max-w-[1400px] mx-auto px-10 py-10">
            {/* Hero summary */}
            {result?.summary && (
              <section className="max-w-3xl motion-safe:animate-fade-in">
                <p className="text-[10px] uppercase tracking-[0.1em] text-brand font-semibold mb-2">
                  Overview
                </p>
                <p className="text-[14px] leading-relaxed font-medium text-ink border-l-2 border-brand/50 pl-4">
                  {result.summary}
                </p>
              </section>
            )}

            {/* Snake card grid + connector overlay */}
            <div ref={gridRef} className="relative mt-10">
              <svg
                aria-hidden="true"
                className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
              >
                <defs>
                  <marker
                    id="storyboard-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0.5 0.8 L7.2 4 L0.5 7.2 z" fill="rgb(var(--brand) / 0.5)" />
                  </marker>
                </defs>
                {links.map((d, i) => (
                  <path
                    key={`${cols}-${i}`}
                    d={d}
                    pathLength={1}
                    strokeDasharray="1"
                    fill="none"
                    stroke="rgb(var(--brand) / 0.4)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    markerEnd="url(#storyboard-arrow)"
                    className="motion-safe:animate-draw"
                    style={{ animationDelay: linkDelay(i) }}
                  />
                ))}
              </svg>

              {rows.map((row, r) => (
                <div
                  key={r}
                  className={`flex gap-6 mb-6 last:mb-0 ${r % 2 === 1 ? 'flex-row-reverse' : ''}`}
                >
                  {row.map((part) => {
                    const i = part.id - 1
                    const isCurrent = part.id === currentPartId
                    const dimmed = matchedIds !== null && !matchedIds.has(part.id)
                    return (
                      <div
                        key={part.id}
                        ref={(el) => registerCard(part.id, el)}
                        role="button"
                        tabIndex={0}
                        onClick={() => setDetailPart(part)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setDetailPart(part)
                          }
                        }}
                        title="Open chapters"
                        style={{ animationDelay: cardDelay(i) }}
                        className={[
                          'relative flex-1 basis-0 min-w-0 bg-surface border rounded-lg shadow-sm p-5 flex flex-col min-h-[180px] cursor-pointer',
                          'transition-all hover:shadow-md motion-safe:hover:-translate-y-1 motion-safe:animate-card-in',
                          isCurrent
                            ? 'border-brand/50 ring-2 ring-brand/50 motion-safe:animate-pulse-brand'
                            : 'border-border hover:border-brand/40',
                          dimmed ? 'opacity-40 saturate-[.6]' : '',
                        ].join(' ')}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="w-7 h-7 shrink-0 rounded-full bg-brand-bg text-brand font-mono text-[12px] tabular-nums flex items-center justify-center">
                            {part.id}
                          </span>
                          <span className="font-mono text-[11px] text-ink-faint tabular-nums border border-border rounded-full px-2 py-0.5">
                            {mmss(part.segment_start)}–{mmss(part.segment_end)}
                          </span>
                          {isCurrent && (
                            <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-brand shrink-0">
                              <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-brand" />
                              Playing
                            </span>
                          )}
                        </div>
                        <h3 className="text-[15px] font-semibold text-ink leading-snug mt-3">
                          {part.title}
                        </h3>
                        {part.description && (
                          <p className="text-[12.5px] text-ink-muted leading-relaxed line-clamp-3 mt-1.5">
                            {part.description}
                          </p>
                        )}
                        <div className="mt-auto pt-3 flex items-center justify-between">
                          <span className="text-[11px] text-ink-faint">
                            {part.chapters.length}{' '}
                            {part.chapters.length === 1 ? 'chapter' : 'chapters'}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              onPartClick(part)
                            }}
                            title="Jump to this part"
                            className="inline-flex items-center gap-1 text-[11px] text-brand hover:text-brand-dark px-2 py-1 rounded-md hover:bg-brand-bg transition-colors"
                          >
                            <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                              <polygon points="2,1 11,6 2,11" />
                            </svg>
                            Jump here
                          </button>
                        </div>
                      </div>
                    )
                  })}
                  {/* Invisible fillers keep the last row's card width consistent. */}
                  {Array.from({ length: cols - row.length }, (_, k) => (
                    <div key={`ph-${k}`} aria-hidden="true" className="flex-1 basis-0" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="shrink-0 px-6 py-2 bg-surface border-t border-border">
        <p className="text-[10px] text-ink-faint">
          Generated by a local model · nothing leaves this machine · the transcript is never
          changed.
        </p>
      </footer>

      {/* Chapter drawer */}
      {detailPart && (
        <>
          <div
            className="absolute inset-0 bg-black/20 motion-safe:animate-fade-in"
            onClick={() => setDetailPart(null)}
          />
          <aside
            className="absolute right-0 top-0 bottom-0 w-[26rem] max-w-full bg-surface border-l border-border shadow-2xl flex flex-col motion-safe:animate-slide-in-r"
            role="dialog"
            aria-label={`Chapters of part ${detailPart.id}`}
          >
            <div className="px-5 py-4 border-b border-border flex items-start gap-3">
              <span className="w-7 h-7 shrink-0 rounded-full bg-brand-bg text-brand font-mono text-[12px] tabular-nums flex items-center justify-center">
                {detailPart.id}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-semibold text-ink leading-snug">
                  {detailPart.title}
                </h3>
                <p className="mt-0.5 font-mono text-[11px] text-ink-faint tabular-nums">
                  {mmss(detailPart.segment_start)}–{mmss(detailPart.segment_end)}
                </p>
              </div>
              <button
                onClick={() => setDetailPart(null)}
                aria-label="Close chapters"
                className="w-7 h-7 shrink-0 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-surface-muted transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M2.5 2.5l8 8M10.5 2.5l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto">
              {detailPart.description && (
                <p className="px-5 pt-4 text-[12.5px] leading-relaxed text-ink-muted">
                  {detailPart.description}
                </p>
              )}
              <div className="px-5 py-4">
                <button
                  onClick={() => onPartClick(detailPart)}
                  className="w-full text-[12px] font-medium px-3 py-2 rounded-md bg-brand text-white hover:bg-brand-dark transition-colors inline-flex items-center justify-center gap-1.5"
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <polygon points="2,1 11,6 2,11" />
                  </svg>
                  Jump to this part
                </button>
              </div>
              {detailPart.chapters.length > 0 && (
                <ol className="border-t border-border divide-y divide-border/50">
                  {detailPart.chapters.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => onChapterClick(c)}
                        className={[
                          'w-full text-left px-5 py-2.5 hover:bg-brand/5 transition-colors group',
                          c.id === currentChapterId ? 'bg-brand-bg' : '',
                        ].join(' ')}
                        title="Jump to this chapter"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="text-[12.5px] text-ink group-hover:text-brand leading-snug">
                            {c.title}
                          </span>
                          <span className="ml-auto font-mono text-[10px] text-ink-faint tabular-nums shrink-0 pl-2">
                            {mmss(c.segment_start)}
                          </span>
                        </div>
                        {c.gist && (
                          <p className="mt-0.5 text-[11px] leading-snug text-ink-faint group-hover:text-ink-muted line-clamp-2">
                            {c.gist}
                          </p>
                        )}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  )
}
