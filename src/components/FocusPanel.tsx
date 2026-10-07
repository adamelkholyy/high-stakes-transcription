import { useState } from 'react'
import type {
  FocusMatchDetail,
  FocusMatchType,
  FocusResult,
  FocusSnippet,
} from '../types'

interface Props {
  // ----- Find (unified lexical + AI retrieval) -----
  text: string
  onTextChange: (text: string) => void
  onRun: () => void
  onClear: () => void
  running: boolean
  /** True while the background local-LLM pass is still merging into the
   *  already-shown lexical hits. */
  aiEnriching: boolean
  active: boolean
  result: FocusResult | null
  /** Focus-only error (e.g. the AI pass when Ollama isn't running). Shown inside
   *  the panel so it never reads as a whole-app failure. */
  error?: string | null
  onSnippetClick: (snippet: FocusSnippet, label: string) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
  /** Optional tab strip (Find | Assistant) rendered in place of the "Find"
   *  title when the assistant chat is enabled (full build). */
  tabStrip?: React.ReactNode
}

// Distinct from the risk palette (red/amber): focus uses violet so a
// focus-driven HIGH is visually separable from a default-HIGH.
const MATCH_CHIP: Record<FocusMatchType, string> = {
  exact: 'bg-focus/15 text-focus border-focus/40',
  alias: 'bg-focus/10 text-focus border-focus/30',
  semantic: 'bg-surface-muted text-ink-muted border-border',
  llm: 'bg-focus/15 text-focus border-focus/40',
}

const MATCH_LABEL: Record<FocusMatchType, string> = {
  exact: 'exact',
  alias: 'alias',
  semantic: 'semantic',
  llm: 'AI',
}

// Approximate match kinds worth flagging to the reviewer (literal/pattern are
// solid, so they get no note).
const DETAIL_NOTE: Partial<Record<FocusMatchDetail, string>> = {
  stem: 'variant',
  partial: 'partial',
  phonetic: 'sounds-alike',
  fuzzy: 'fuzzy',
  expanded: 'related',
}

function totalHits(result: FocusResult | null): number {
  if (!result) return 0
  return result.terms.reduce((n, t) => n + t.snippets.length, 0)
}

export default function FocusPanel({
  text,
  onTextChange,
  onRun,
  onClear,
  running,
  aiEnriching,
  active,
  result,
  error,
  onSnippetClick,
  collapsed = false,
  onToggleCollapse,
  tabStrip,
}: Props) {
  const [showHelp, setShowHelp] = useState(false)
  const hits = totalHits(result)

  if (collapsed) {
    return (
      <aside className="w-9 shrink-0 border-r border-border bg-surface flex flex-col items-center gap-3 py-3">
        <button
          onClick={onToggleCollapse}
          title="Expand find panel"
          className="text-ink-muted hover:text-brand p-1 rounded hover:bg-surface-muted"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4.5 2.5 8 6l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="[writing-mode:vertical-rl] text-[10px] text-brand uppercase tracking-[0.1em] font-semibold">
          Find
        </span>
        {active && (
          <span className="font-mono text-[10px] text-ink-faint tabular-nums">{hits}</span>
        )}
      </aside>
    )
  }

  return (
    <aside className="w-80 shrink-0 border-r border-border bg-surface overflow-y-auto flex flex-col" data-tour="left-panel">
      <div className="px-4 py-3 border-b border-border sticky top-0 bg-surface z-10">
        <div className="flex items-start justify-between gap-2 mb-2">
          {tabStrip ?? (
            <p className="text-[10px] text-brand uppercase tracking-[0.1em] font-semibold">
              Find
            </p>
          )}
          <div className="flex items-center gap-2 shrink-0">
            {active && (
              <p className="text-[10px] font-mono text-ink-faint tabular-nums">
                {hits} {hits === 1 ? 'hit' : 'hits'}
              </p>
            )}
            {onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                title="Collapse find panel"
                className="text-ink-faint hover:text-ink p-0.5 rounded hover:bg-surface-muted"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M7.5 2.5 4 6l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <FindControls
          text={text}
          onTextChange={onTextChange}
          onRun={onRun}
          onClear={onClear}
          running={running}
          aiEnriching={aiEnriching}
          active={active}
          result={result}
          showHelp={showHelp}
          setShowHelp={setShowHelp}
        />
      </div>

      <FindResults
        active={active}
        result={result}
        hits={hits}
        error={error}
        onSnippetClick={onSnippetClick}
      />
    </aside>
  )
}

function FindControls({
  text,
  onTextChange,
  onRun,
  onClear,
  running,
  aiEnriching,
  active,
  result,
  showHelp,
  setShowHelp,
}: {
  text: string
  onTextChange: (t: string) => void
  onRun: () => void
  onClear: () => void
  running: boolean
  aiEnriching: boolean
  active: boolean
  result: FocusResult | null
  showHelp: boolean
  setShowHelp: (fn: (s: boolean) => boolean) => void
}) {
  return (
    <>
      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter runs focus without forcing a button hunt.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            onRun()
          }
        }}
        rows={3}
        placeholder={'Add a name, object, or topic…'}
        className="w-full text-[13px] leading-snug border border-border rounded px-2 py-1.5 bg-surface resize-y placeholder:text-ink-faint/60 focus:outline-none focus:ring-1 focus:ring-brand/50 focus:border-brand/50"
      />

      <div className="mt-1 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setShowHelp((s) => !s)}
          className="text-[10px] text-ink-faint hover:text-ink underline decoration-dotted underline-offset-2"
        >
          how to enter terms
        </button>
        {aiEnriching && (
          <span className="text-[10px] text-brand/80 flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full border border-brand/60 border-t-transparent animate-spin" />
            AI refining…
          </span>
        )}
      </div>
      {showHelp && (
        <p className="mt-1 text-[10px] text-ink-muted leading-relaxed bg-surface-subtle rounded px-2 py-1.5">
          One query per line — a keyword (<span className="font-mono">weapon</span>),
          a keyword with comma-separated{' '}
          <span className="font-medium">aliases</span> after a colon
          (<span className="font-mono">weapon: gun, knife</span>), or a plain-English
          need (<span className="font-mono">who paid for the taxi</span>). Related
          wording from this transcript is pulled in automatically, and a{' '}
          <span className="font-medium text-focus">local model</span> then adds
          segments that are <em>about</em> your query even when they don't use its
          words. Everything stays on your machine — nothing is uploaded.
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button
          onClick={onRun}
          disabled={running || text.trim() === ''}
          className="flex-1 text-xs font-medium px-3 py-1.5 rounded bg-brand text-white hover:bg-brand-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {running ? 'Searching…' : 'Find'}
        </button>
        <button
          onClick={onClear}
          disabled={!active && !result}
          className="text-xs px-3 py-1.5 rounded border border-border text-ink-muted bg-surface hover:border-ink-muted hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Clear
        </button>
      </div>
    </>
  )
}

function FindResults({
  active,
  result,
  hits,
  error,
  onSnippetClick,
}: {
  active: boolean
  result: FocusResult | null
  hits: number
  error?: string | null
  onSnippetClick: (snippet: FocusSnippet, label: string) => void
}) {
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      {error && (
        <div className="mb-3 rounded border border-risk-med/30 bg-risk-med-bg px-2.5 py-2">
          {result ? (
            <>
              {/* Lexical search succeeded; only the optional AI pass failed. */}
              <p className="text-[11px] font-semibold text-risk-med">
                AI refinement unavailable
              </p>
              <p className="mt-1 text-[10px] text-ink-muted leading-snug break-words">
                {error}
              </p>
              <p className="mt-1.5 text-[10px] text-ink-faint leading-snug">
                Your keyword results above are unaffected — they come from the
                local lexical engine, which needs no model.
              </p>
            </>
          ) : (
            <>
              {/* The search itself (lexical) failed — there are no results. */}
              <p className="text-[11px] font-semibold text-risk-med">
                Search unavailable
              </p>
              <p className="mt-1 text-[10px] text-ink-muted leading-snug break-words">
                {error}
              </p>
              <p className="mt-1.5 text-[10px] text-ink-faint leading-snug">
                The search service runs locally on port 8000 — make sure it's
                running, then try again.
              </p>
            </>
          )}
        </div>
      )}
      {!active || !result ? (
        <p className="py-8 px-2 text-center text-[11px] text-ink-faint italic leading-relaxed">
          Add the names, objects, or topics that matter — matches jump the audio there.
        </p>
      ) : hits === 0 ? (
        <p className="py-8 px-2 text-center text-[11px] text-ink-faint italic">
          No segments matched these terms. Try adding aliases (e.g.{' '}
          <span className="font-mono not-italic">weapon: gun, knife</span>).
        </p>
      ) : (
        <div className="space-y-4">
          {result.terms.map((term) => (
            <section key={term.focus_label}>
              <div className="flex items-baseline justify-between mb-1 px-1">
                <h3 className="text-xs font-semibold text-ink truncate">
                  {term.focus_label}
                </h3>
                <span className="text-[10px] font-mono text-ink-faint tabular-nums shrink-0 ml-2">
                  {term.snippets.length}
                </span>
              </div>
              {term.auto_aliases && term.auto_aliases.length > 0 && (
                <p className="px-1 mb-1.5 text-[10px] text-ink-faint leading-snug">
                  + related in this transcript:{' '}
                  <span className="text-focus/90">{term.auto_aliases.join(', ')}</span>
                </p>
              )}
              {term.snippets.length === 0 ? (
                <p className="px-1 text-[11px] text-ink-faint italic">no matches</p>
              ) : (
                <ol className="space-y-1">
                  {term.snippets.map((s, i) => (
                    <li key={`${s.segment_id}-${i}`}>
                      <button
                        onClick={() => onSnippetClick(s, term.focus_label)}
                        className="w-full text-left rounded px-2 py-1.5 hover:bg-focus/5 border border-transparent hover:border-focus/20 transition-colors group"
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span
                            className={`text-[10px] font-mono uppercase px-1 py-px rounded-sm border ${MATCH_CHIP[s.match_type]}`}
                          >
                            {MATCH_LABEL[s.match_type]}
                          </span>
                          <span className="text-[10px] font-mono text-ink-faint tabular-nums">
                            {s.focus_score.toFixed(2)}
                          </span>
                          {s.match_detail && DETAIL_NOTE[s.match_detail] && (
                            <span className="text-[9px] italic text-focus/80">
                              {DETAIL_NOTE[s.match_detail]}
                            </span>
                          )}
                          <span className="text-[10px] font-mono text-ink-faint tabular-nums ml-auto">
                            {formatTime(s.segment_start)}
                          </span>
                        </div>
                        <p className="text-[12px] leading-snug text-ink-muted group-hover:text-ink line-clamp-2">
                          {s.evidence}
                        </p>
                        {s.llm_reason && (
                          <p className="mt-0.5 text-[10px] italic text-focus/80 leading-snug line-clamp-2">
                            {s.llm_reason}
                          </p>
                        )}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
