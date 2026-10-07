import { useLayoutEffect, useRef, useState } from 'react'
import type { Risk, Segment } from '../types'
import type { TimelineItem } from './TimelinePanel'

// Full-width, time-proportional timeline strip (timeline build only). It sits
// on top of the PlayerBar and reads as a rich view that "pulls up" out of the
// bottom scrubber: a collapsed handle bar always shows; opening pops the panel
// up with a connector playhead that draws from the bar into the panel. Layers:
//   pin markers  — LLM events, positioned at their real time, stems to track
//   track        — risk heat band (same signal as the transcript), verified
//                  progress bars, elapsed veil, ghost cursor
//   tick row     — mm:ss labels
//   playhead     — brand connector line + knob following audio.currentTime
// Hover is synced both ways with the left TimelinePanel list via the items
// *index* (event ids are segment ids and can repeat).
interface Props {
  segments: Segment[]
  duration: number
  currentTime: number
  items: TimelineItem[]
  running: boolean
  tintMap: Map<number, Risk>
  verified: Record<number, boolean>
  activeSegmentId: number | null
  hoveredEventIndex: number | null
  onEventHover: (index: number | null) => void
  onEventClick: (item: TimelineItem, index: number) => void
  onTrackSeek: (seconds: number) => void
  open: boolean
  onToggle: () => void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

const CARD_W = 256 // w-64, for edge clamping

export default function TimelineStrip({
  segments,
  duration,
  currentTime,
  items,
  running,
  tintMap,
  verified,
  activeSegmentId,
  hoveredEventIndex,
  onEventHover,
  onEventClick,
  onTrackSeek,
  open,
  onToggle,
}: Props) {
  const innerRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [ghost, setGhost] = useState<{ x: number; t: number } | null>(null)

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [open])

  // One shared duration for band, markers, playhead AND click→seconds so all
  // four can never disagree.
  const dur = duration > 0 ? duration : 1
  const pct = (t: number) => Math.min(100, Math.max(0, (t / dur) * 100))
  const playedPct = pct(currentTime)

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    onTrackSeek(frac * dur)
  }

  const handleTrackMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left))
    setGhost({ x, t: (x / rect.width) * dur })
  }

  const cardItem = hoveredEventIndex != null ? items[hoveredEventIndex] : undefined
  const cardLeft = cardItem
    ? Math.min(Math.max((pct(cardItem.segment_start) / 100) * width - CARD_W / 2, 0), Math.max(width - CARD_W, 0))
    : 0

  const nEvents = items.length

  return (
    <div className="relative shrink-0 border-t border-border bg-gradient-to-b from-surface to-surface-muted">
      {/* ---- The panel (pulls up out of the handle) --------------------- */}
      {open && (
        <div
          key="strip-panel"
          className="relative px-5 pt-2.5 pb-1 motion-safe:animate-strip-up"
        >
          <div ref={innerRef} className="relative">
            {/* Marker lane — pins with stems reaching the track. */}
            <div className="relative h-6">
              {running && (
                <span className="absolute left-0 top-0 text-[10px] text-ink-faint animate-pulse">
                  Finding events…
                </span>
              )}
              {items.map((item, i) => {
                const active = item.id === activeSegmentId
                const hovered = hoveredEventIndex === i
                const passed = item.segment_start < currentTime && !active
                return (
                  <button
                    key={`${item.id}-${i}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onEventClick(item, i)
                    }}
                    onMouseEnter={() => onEventHover(i)}
                    onMouseLeave={() => onEventHover(null)}
                    onFocus={() => onEventHover(i)}
                    onBlur={() => onEventHover(null)}
                    aria-label={`Jump to “${item.event}” at ${formatTime(item.segment_start)}`}
                    style={{
                      left: `${pct(item.segment_start)}%`,
                      animationDelay: `${Math.min(i * 45, 500)}ms`,
                    }}
                    className="group absolute top-0 bottom-0 -translate-x-1/2 flex flex-col items-center outline-none motion-safe:animate-card-in"
                  >
                    {/* head */}
                    <span
                      className={[
                        'w-2.5 h-2.5 rounded-full ring-2 ring-surface shadow-sm transition-transform',
                        'group-hover:scale-[1.35] group-focus-visible:scale-[1.35] group-focus-visible:ring-brand/60',
                        active
                          ? 'bg-brand-dark motion-safe:animate-pulse-brand'
                          : passed
                            ? 'bg-brand/45'
                            : 'bg-brand',
                        hovered ? 'scale-[1.35] z-10' : '',
                      ].join(' ')}
                    />
                    {/* stem down to the track */}
                    <span
                      className={`flex-1 w-px ${
                        active ? 'bg-brand-dark/50' : passed ? 'bg-brand/20' : 'bg-brand/30'
                      } group-hover:bg-brand/60 transition-colors`}
                    />
                  </button>
                )
              })}
            </div>

            {/* Track: risk band + verified bars + elapsed veil + ghost. */}
            <div
              ref={trackRef}
              onClick={handleTrackClick}
              onMouseMove={handleTrackMove}
              onMouseLeave={() => setGhost(null)}
              title="Click to jump to that moment"
              className="relative h-6 rounded-lg border border-border bg-surface-subtle overflow-hidden cursor-pointer shadow-inner"
            >
              {segments.map((s) => {
                const tint = tintMap.get(s.id)
                if (!tint || tint === 'low') return null
                return (
                  <div
                    key={`risk-${s.id}`}
                    style={{
                      left: `${pct(s.start)}%`,
                      width: `${Math.max(pct(s.end) - pct(s.start), 0.3)}%`,
                    }}
                    className={`absolute inset-y-0 pointer-events-none ${
                      tint === 'high' ? 'bg-risk-high/55' : 'bg-risk-med/50'
                    }`}
                  />
                )
              })}
              {segments.map((s) =>
                verified[s.id] ? (
                  <div
                    key={`ver-${s.id}`}
                    style={{
                      left: `${pct(s.start)}%`,
                      width: `${Math.max(pct(s.end) - pct(s.start), 0.3)}%`,
                    }}
                    className="absolute bottom-0 h-1.5 bg-verified-bar/85 rounded-[1px] pointer-events-none"
                  />
                ) : null,
              )}
              <div
                style={{ width: `${playedPct}%` }}
                className="absolute inset-y-0 left-0 bg-ink/[0.07] pointer-events-none"
              />
              {ghost && (
                <div
                  style={{ left: `${ghost.x}px` }}
                  className="absolute inset-y-0 w-px bg-ink/25 pointer-events-none"
                />
              )}
            </div>

            {/* Tick row. */}
            <div className="relative h-3.5 mt-0.5 font-mono text-[9px] text-ink-faint tabular-nums">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <span
                  key={f}
                  style={{ left: `${f * 100}%` }}
                  className={`absolute top-0 ${
                    f === 0 ? '' : f === 1 ? '-translate-x-full' : '-translate-x-1/2'
                  }`}
                >
                  {formatTime(f * dur)}
                </span>
              ))}
            </div>

            {/* Ghost time bubble. */}
            {ghost && (
              <div
                style={{ left: `${Math.min(Math.max(ghost.x - 16, 0), Math.max(width - 34, 0))}px` }}
                className="absolute -top-3.5 px-1 rounded border border-border bg-surface font-mono text-[9px] text-ink-muted tabular-nums pointer-events-none shadow-sm"
              >
                {formatTime(ghost.t)}
              </div>
            )}

            {/* Rich hover card (marker OR list-row hover). */}
            {cardItem && (
              <div
                style={{ left: `${cardLeft}px` }}
                className="absolute bottom-full mb-2 w-64 z-20 pointer-events-none bg-surface border border-border rounded-lg shadow-xl px-3 py-2 motion-safe:animate-card-in"
              >
                <span className="font-mono text-[10px] text-brand tabular-nums">
                  {formatTime(cardItem.segment_start)}
                </span>
                <p className="text-[12px] text-ink leading-snug">{cardItem.event}</p>
                {cardItem.time && (
                  <p className="text-[11px] text-ink-faint italic leading-snug">“{cardItem.time}”</p>
                )}
                <p className="text-[9px] text-ink-faint mt-1">
                  Click to jump · AI-suggested, verify against audio
                </p>
              </div>
            )}
          </div>

          {/* Connector playhead — draws up from the bar into the panel, then
              tracks currentTime. Absolutely placed over the whole panel so the
              line visually roots the popped-out strip to the moment below. */}
          <div
            style={{ left: `calc(1.25rem + ${playedPct / 100} * (100% - 2.5rem))` }}
            className="absolute top-2 -bottom-1 w-px -translate-x-1/2 origin-bottom pointer-events-none z-10 motion-safe:animate-stem-up"
          >
            <div className="w-full h-full bg-brand/80" />
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-brand ring-2 ring-surface shadow" />
            {/* root dot sitting on the bar edge */}
            <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-brand/70" />
          </div>
        </div>
      )}

      {/* ---- Handle bar (always visible; the anchor the panel pops from) - */}
      <button
        onClick={onToggle}
        title={open ? 'Hide timeline' : 'Show timeline'}
        className="w-full flex items-center gap-2 px-5 py-1 hover:bg-surface-subtle/60 transition-colors"
      >
        <span className="text-[10px] uppercase tracking-[0.12em] text-ink-muted font-semibold">
          Timeline
        </span>
        {nEvents > 0 && (
          <span className="text-[9px] font-mono tabular-nums text-brand bg-brand-bg rounded-full px-1.5 py-px">
            {nEvents}
          </span>
        )}
        {running && <span className="text-[9px] text-ink-faint animate-pulse">finding events…</span>}
        <span className="flex-1" />
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={`text-ink-faint transition-transform ${open ? '' : 'rotate-180'}`}
        >
          <path d="M2.5 7.5 6 4l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}
