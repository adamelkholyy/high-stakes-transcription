import { useState } from 'react'

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['Space'], label: 'Play / pause (rewinds 2 s on resume)' },
  { keys: ['←', '→'], label: 'Seek ±5 s' },
  { keys: ['J'], label: 'Previous segment' },
  { keys: ['K'], label: 'Next segment' },
  { keys: ['R'], label: 'Replay current segment' },
  { keys: ['V'], label: 'Verify active segment' },
  { keys: ['⇧', 'V'], label: 'Verify + next segment' },
]

export default function ShortcutLegend() {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-64 bg-surface border border-border rounded-md shadow-lg p-3 z-40">
          <p className="text-[10px] text-ink-faint uppercase tracking-[0.1em] mb-2">
            Keyboard shortcuts
          </p>
          <ul className="space-y-1.5">
            {SHORTCUTS.map((s) => (
              <li
                key={s.label}
                className="flex items-center justify-between text-xs"
              >
                <span className="text-ink">{s.label}</span>
                <span className="flex items-center gap-1">
                  {s.keys.map((k) => (
                    <kbd
                      key={k}
                      className="font-mono text-[10px] px-1.5 py-0.5 bg-surface-muted border border-border rounded text-ink-muted min-w-[1.25rem] text-center"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>

        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        className="flex items-center gap-2 px-2.5 py-1.5 bg-surface border border-border rounded-md shadow-sm hover:border-border-strong transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-muted">
          <rect x="0.5" y="3" width="13" height="8" rx="1.5" />
          <path d="M3 6h0M5 6h0M7 6h0M9 6h0M11 6h0M3 8.5h8" strokeLinecap="round" />
        </svg>
        <span className="text-[11px] text-ink-muted">Shortcuts</span>
      </button>
    </div>
  )
}
