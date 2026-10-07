import { useEffect, useRef, useState } from 'react'
import type { ChatCitation } from '../lib/chatApi'

// ---------------------------------------------------------------------------
// AI assistant chat panel (full/police build only) — a tab beside Find in the
// left column. Answers come from a LOCAL Ollama model and are grounded in
// SERVER-VERIFIED segment citations; clicking a citation seeks the audio.
// The conversation is ephemeral: in-memory only, cleared on transcript change,
// never part of the audit trail or any export.
// ---------------------------------------------------------------------------

export interface ChatUiTurn {
  role: 'user' | 'assistant'
  content: string
  citations?: ChatCitation[]
}

interface Props {
  messages: ChatUiTurn[]
  thinking: boolean
  /** Panel-local error (e.g. Ollama down) — never a whole-app failure. */
  error?: string | null
  onSend: (text: string) => void
  onClear: () => void
  onCitationClick: (citation: ChatCitation) => void
  /** The Find | Assistant tab strip (always present — this panel only exists
   *  in the tabbed, full-build layout). */
  tabStrip: React.ReactNode
  onToggleCollapse?: () => void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function ChatPanel({
  messages,
  thinking,
  error,
  onSend,
  onClear,
  onCitationClick,
  tabStrip,
  onToggleCollapse,
}: Props) {
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  // Keep the newest turn in view (also while the thinking row appears).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, thinking])

  const send = () => {
    const text = draft.trim()
    if (!text || thinking) return
    setDraft('')
    onSend(text)
  }

  return (
    <aside className="w-80 shrink-0 border-r border-border bg-surface flex flex-col overflow-hidden" data-tour="left-panel">
      {/* Header — tab strip + collapse, mirroring FocusPanel's header row. */}
      <div className="px-4 py-3 border-b border-border shrink-0 bg-surface">
        <div className="flex items-start justify-between gap-2">
          {tabStrip}
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              title="Collapse panel"
              className="shrink-0 text-ink-faint hover:text-ink p-0.5 rounded hover:bg-surface-muted"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7.5 2.5 4 6l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && !thinking && !error && (
          <p className="px-1 pt-6 text-[12px] leading-relaxed text-ink-faint italic text-center">
            Ask about this transcript — e.g. “who paid for the taxi” or “was a
            weapon mentioned”. Answers cite segments; click a citation to jump
            the audio there.
          </p>
        )}

        {messages.map((m, i) => (
          <div key={i}>
            <p className="text-[9px] text-ink-faint uppercase tracking-[0.1em] mb-0.5">
              {m.role === 'user' ? 'You' : 'Assistant'}
            </p>
            <p className="text-[12px] leading-snug text-ink whitespace-pre-wrap">{m.content}</p>
            {m.role === 'assistant' &&
              (m.citations && m.citations.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.citations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => onCitationClick(c)}
                      title={`${c.quote ? `“${c.quote}” — ` : ''}${c.evidence.slice(0, 160)}`}
                      className="text-[10px] font-mono px-1 py-px rounded-sm border bg-focus/15 text-focus border-focus/40 hover:bg-focus/25 transition-colors tabular-nums"
                    >
                      [{c.id}] {formatTime(c.segment_start)}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-[10px] italic text-risk-med">
                  No transcript citations — treat with caution.
                </p>
              ))}
          </div>
        ))}

        {thinking && (
          <div className="flex items-center gap-2 text-ink-faint">
            <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-brand/60 border-t-transparent animate-spin" />
            <span className="text-[11px]">Thinking…</span>
          </div>
        )}

        {error && (
          <div className="rounded border border-risk-med/30 bg-risk-med-bg px-3 py-2.5">
            <p className="text-[12px] font-semibold text-risk-med">Assistant unavailable</p>
            <p className="mt-1 text-[11px] text-ink-muted leading-snug break-words whitespace-pre-wrap">
              {error}
            </p>
            <p className="mt-1.5 text-[11px] text-ink-faint leading-snug">
              The assistant runs on a local service at port 8000 — make sure
              it's running, then ask again.
            </p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border px-3 py-2 shrink-0 bg-surface">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          rows={2}
          placeholder="Ask about this transcript…"
          className="w-full text-[13px] leading-snug border border-border rounded px-2.5 py-1.5 bg-surface resize-none placeholder:text-ink-faint/60 focus:outline-none focus:ring-1 focus:ring-brand/50 focus:border-brand/50"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button
            onClick={send}
            disabled={thinking || draft.trim() === ''}
            title="Send (⌘/Ctrl+Enter)"
            className="flex-1 text-[12px] font-medium px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
          <button
            onClick={onClear}
            disabled={messages.length === 0 && !error}
            className="text-[12px] px-3 py-1.5 rounded-md border border-border text-ink-muted hover:text-ink hover:border-border-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-ink-faint leading-snug">
          AI assistant — verify against the audio; answers are not part of the
          record.
        </p>
      </div>
    </aside>
  )
}
