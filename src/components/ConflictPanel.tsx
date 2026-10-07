import type { ConflictPair, ConflictType } from '../types'

// A conflict pair joined (in the workspace) to each side's segment start time
// and a short text preview, so the panel can jump and the reviewer can see at
// a glance which two statements are being compared.
export interface ConflictItem extends ConflictPair {
  aStart: number
  bStart: number
  aText: string
  bText: string
}

interface Props {
  items: ConflictItem[]
  running: boolean
  /** Ollama-down / service error — shown inside the panel, never as a modal. */
  error?: string | null
  onJump: (segId: number, start: number, item: ConflictItem) => void
  onRetry: () => void
  onToggleCollapse?: () => void
  /** Tab strip (Find | Assistant | Conflicts) rendered as the panel title. */
  tabStrip?: React.ReactNode
}

const TYPE_LABEL: Record<ConflictType, string> = {
  time: 'time',
  place: 'place',
  person: 'person',
  statement: 'statement',
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Left "Conflicts" tab (anomaly build): pairs of statements the local LLM
// thinks contradict each other. Each side is a jump button; the matching
// segments carry an amber tint in the transcript. Pointing aid only — the
// reviewer decides by re-listening.
export default function ConflictPanel({
  items,
  running,
  error,
  onJump,
  onRetry,
  onToggleCollapse,
  tabStrip,
}: Props) {
  return (
    <aside className="w-80 shrink-0 border-r border-border bg-surface overflow-y-auto flex flex-col" data-tour="left-panel">
      <div className="px-4 py-3 border-b border-border sticky top-0 bg-surface z-10">
        <div className="flex items-start justify-between gap-2 mb-1">
          {tabStrip ?? (
            <p className="text-[10px] text-brand uppercase tracking-[0.1em] font-semibold">
              Conflicts
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
          Statements the AI thinks contradict each other — listen to both sides
          before deciding. AI-suggested; it can be wrong in either direction.
        </p>
      </div>

      <div className="flex-1 px-2 py-2">
        {running ? (
          <p className="px-2 py-3 text-[12px] text-ink-muted animate-pulse">
            Cross-checking statements…
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
            No conflicting statements flagged in this transcript.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, i) => (
              <li
                key={`${item.a}-${item.b}-${i}`}
                className="rounded border border-border bg-surface px-2.5 py-2"
              >
                <p className="flex items-baseline gap-2 mb-1.5">
                  <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] font-semibold px-1.5 py-0.5 rounded border border-risk-med/40 bg-risk-med-bg/60 text-risk-med">
                    {TYPE_LABEL[item.type]}
                  </span>
                  <span className="text-[12px] text-ink leading-snug">{item.note}</span>
                </p>
                {(
                  [
                    { id: item.a, start: item.aStart, text: item.aText },
                    { id: item.b, start: item.bStart, text: item.bText },
                  ] as const
                ).map((side) => (
                  <button
                    key={side.id}
                    onClick={() => onJump(side.id, side.start, item)}
                    title="Jump to this statement"
                    className="w-full text-left px-1.5 py-1 rounded hover:bg-surface-muted transition-colors group flex items-baseline gap-2"
                  >
                    <span className="font-mono text-[10px] text-brand tabular-nums shrink-0 group-hover:underline">
                      {formatTime(side.start)}
                    </span>
                    <span className="text-[11px] text-ink-muted leading-snug truncate">
                      {side.text}
                    </span>
                  </button>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
