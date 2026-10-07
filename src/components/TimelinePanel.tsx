import type { TimelineEvent } from '../types'

// A timeline event joined (in the workspace) to the start time of the segment
// it cites, so a click can seek the audio directly.
export interface TimelineItem extends TimelineEvent {
  segment_start: number
}

interface Props {
  items: TimelineItem[]
  running: boolean
  /** Ollama-down / service error — shown inside the panel, never as a modal. */
  error?: string | null
  onEventClick: (item: TimelineItem) => void
  onRetry: () => void
  onToggleCollapse?: () => void
  /** Tab strip (Find | Assistant | Timeline) rendered as the panel title. */
  tabStrip?: React.ReactNode
  // List↔strip hover sync (TimelineStrip), keyed by the items array index —
  // event ids are segment ids and can repeat. All optional: the panel is
  // unchanged when no strip is mounted.
  hoveredIndex?: number | null
  onEventHover?: (index: number | null) => void
  /** Segment currently under the playhead — gets a brand accent. */
  activeSegmentId?: number | null
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Left "Timeline" tab (timeline build): the concrete events the local LLM
// extracted, in transcript order. Every row cites a segment — clicking seeks
// the audio there. Navigation overlay only; the reviewer verifies by listening.
export default function TimelinePanel({
  items,
  running,
  error,
  onEventClick,
  onRetry,
  onToggleCollapse,
  tabStrip,
  hoveredIndex,
  onEventHover,
  activeSegmentId,
}: Props) {
  return (
    <aside className="w-80 shrink-0 border-r border-border bg-surface overflow-y-auto flex flex-col" data-tour="left-panel">
      <div className="px-4 py-3 border-b border-border sticky top-0 bg-surface z-10">
        <div className="flex items-start justify-between gap-2 mb-1">
          {tabStrip ?? (
            <p className="text-[10px] text-brand uppercase tracking-[0.1em] font-semibold">
              Timeline
            </p>
          )}
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              title="Collapse panel"
              className="shrink-0 text-ink-faint hover:text-ink p-1 rounded hover:bg-surface-muted"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7.5 2.5 4 6l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        <p className="text-[11px] text-ink-faint leading-snug">
          Events the AI found in the recording — click one to listen to that
          moment. AI-suggested; always verify against the audio.
        </p>
      </div>

      <div className="flex-1 px-2 py-2">
        {running ? (
          <p className="px-2 py-3 text-[12px] text-ink-muted animate-pulse">
            Extracting events…
          </p>
        ) : error ? (
          <div className="px-2 py-3 space-y-2">
            <p className="text-[12px] text-risk-high leading-snug">{error}</p>
            <button
              onClick={onRetry}
              className="text-[11px] font-medium px-2.5 py-1 rounded border border-border text-ink-muted hover:text-ink hover:border-border-strong transition-colors"
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-ink-muted">
            No concrete events found in this recording.
          </p>
        ) : (
          <ol className="space-y-0.5">
            {items.map((item, i) => (
              <li key={`${item.id}-${i}`}>
                <button
                  onClick={() => onEventClick(item)}
                  onMouseEnter={() => onEventHover?.(i)}
                  onMouseLeave={() => onEventHover?.(null)}
                  title="Jump to this moment"
                  className={[
                    'w-full text-left px-2 py-1.5 rounded hover:bg-surface-muted transition-colors group',
                    hoveredIndex === i ? 'bg-brand-bg' : '',
                    item.id === activeSegmentId ? 'border-l-2 border-brand pl-1.5' : '',
                  ].join(' ')}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[10px] text-brand tabular-nums shrink-0 group-hover:underline">
                      {formatTime(item.segment_start)}
                    </span>
                    <span className="text-[12px] text-ink leading-snug">{item.event}</span>
                  </span>
                  {item.time && (
                    <span className="block pl-9 text-[11px] text-ink-faint italic leading-snug">
                      “{item.time}”
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}
