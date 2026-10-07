import { useState } from 'react'
import type { EditState, HistoryEntry, ModelName, Transcript } from '../types'
import { exportHistoryAsCSV, exportHistoryAsJSON } from '../utils/exportHistory'
import {
  exportRawPipelineJson,
  exportSourceTranscriptJson,
  exportTranscriptJson,
  exportTranscriptReportHtml,
  exportTranscriptText,
} from '../utils/exportTranscript'

interface Props {
  history: HistoryEntry[]
  verified: Record<number, boolean>
  verifiedCount: number
  totalSegments: number
  // High-risk segments still unverified (null when no risk layer is shown, e.g. C1).
  highRiskRemaining?: number | null
  // Data needed to produce the reviewed-transcript exports:
  transcript: Transcript
  model: ModelName
  edits: Record<string, EditState>
  segmentTextEdits?: Record<number, { text: string; reason?: string }>
  // Pristine raw transcript for the "Original (JSON)" export (manual structural
  // edits live in `transcript`, not here).
  sourceTranscript?: Transcript
  // Exact backend JSON before the ASR adapter, for the "Pipeline raw (JSON)"
  // export. For a normal backend this equals the transcript.
  rawSource?: unknown
  reviewer: string
  audioFilename: string | null
  transcriptFilename: string | null
  onExport?: (kind: string, count: number) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

function formatAction(entry: HistoryEntry): React.ReactNode {
  if (entry.kind === 'edit') {
    return (
      <span>
        <span className="line-through text-ink-faint">{entry.from || '∅'}</span>
        <span className="mx-1.5 text-ink-faint">→</span>
        <span className="font-medium text-ink">{entry.to}</span>
      </span>
    )
  }
  if (entry.kind === 'delete') {
    return (
      <span>
        <span className="line-through text-ink-faint">{entry.from || '∅'}</span>
        <span className="mx-1.5 text-ink-faint">→</span>
        <span className="font-medium text-risk-high">(deleted)</span>
      </span>
    )
  }
  if (entry.kind === 'split') {
    return <span className="text-ink-muted font-medium">Split segment {entry.to}</span>
  }
  if (entry.kind === 'merge') {
    return <span className="text-ink-muted font-medium">Merged {entry.to}</span>
  }
  if (entry.kind === 'speaker') {
    return (
      <span className="font-medium text-ink">
        Speaker:{' '}
        <span className="line-through text-ink-faint">{entry.from}</span>
        <span className="mx-1.5 text-ink-faint">→</span>
        {entry.to}
      </span>
    )
  }
  const n = entry.segmentIds?.length
  if (entry.kind === 'verify') {
    return (
      <span className="text-verified font-medium">
        {n && n > 1 ? `Verified ${n} segments` : 'Verified segment'}
      </span>
    )
  }
  return (
    <span className="text-ink-muted font-medium">
      {n && n > 1 ? `Un-verified ${n} segments` : 'Un-verified segment'}
    </span>
  )
}

// Dots follow the same discipline: blue = reviewer change, red = delete,
// green = verified, gray = un-verify / neutral structural edits.
const KIND_DOT: Record<HistoryEntry['kind'], string> = {
  edit: 'bg-change-ins',
  delete: 'bg-risk-high',
  verify: 'bg-verified-bar',
  unverify: 'bg-border-strong',
  split: 'bg-change-ins',
  merge: 'bg-change-ins',
  speaker: 'bg-change-ins',
}

interface ExportButtonProps {
  label: string
  onClick: () => void
  disabled?: boolean
}

function ExportButton({ label, onClick, disabled }: ExportButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] font-mono px-2 py-0.5 border border-border rounded hover:border-border-strong text-ink-muted hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {label}
    </button>
  )
}

export default function HistorySidebar({
  history,
  verified,
  verifiedCount,
  totalSegments,
  highRiskRemaining,
  transcript,
  model,
  edits,
  segmentTextEdits,
  sourceTranscript,
  rawSource,
  reviewer,
  audioFilename,
  transcriptFilename,
  onExport,
  collapsed = false,
  onToggleCollapse,
}: Props) {
  const progress = totalSegments === 0 ? 0 : (verifiedCount / totalSegments) * 100
  const hasHistory = history.length > 0
  // Exports are a secondary task — collapsed by default so the panel reads as a
  // reviewer work panel (progress + recent changes), not an export console.
  const [exportOpen, setExportOpen] = useState(false)

  if (collapsed) {
    return (
      <aside className="w-9 shrink-0 border-l border-border bg-surface flex flex-col items-center gap-3 py-3">
        <button
          onClick={onToggleCollapse}
          title="Expand review panel"
          className="text-ink-muted hover:text-ink p-1 rounded hover:bg-surface-muted"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M7.5 2.5 4 6l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={onToggleCollapse}
          title="Expand review panel"
          className="[writing-mode:vertical-rl] text-[10px] text-ink-faint uppercase tracking-[0.1em] hover:text-ink"
        >
          Review
        </button>
        <span className="font-mono text-[10px] text-ink-faint tabular-nums">
          {verifiedCount}/{totalSegments}
        </span>
      </aside>
    )
  }

  const exportArgs = {
    transcript,
    model,
    edits,
    segmentTextEdits,
    verified,
    reviewer,
    audioFilename,
    transcriptFilename,
  }

  return (
    <aside
      className="w-80 shrink-0 border-l border-border bg-surface overflow-hidden flex flex-col"
      data-tour="right-panel"
    >
      {/* Review progress — the reviewer's "how much is left" panel. */}
      <div className="px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center justify-between mb-2 gap-2">
          <p className="text-[10px] text-ink-faint uppercase tracking-[0.1em]">Review</p>
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              title="Collapse review panel"
              className="text-ink-faint hover:text-ink p-0.5 rounded hover:bg-surface-muted"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4.5 2.5 8 6l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-baseline justify-between mb-1 gap-2">
          <p className="text-xs text-ink">
            Verified{' '}
            <span className="font-mono tabular-nums font-medium">
              {verifiedCount} / {totalSegments}
            </span>{' '}
            segments
          </p>
          {highRiskRemaining != null && (
            <span
              className={`text-[11px] font-medium shrink-0 ${
                highRiskRemaining > 0 ? 'text-risk-high' : 'text-verified'
              }`}
              title="High-risk segments still unverified"
            >
              {highRiskRemaining > 0 ? `${highRiskRemaining} high-risk left` : 'high-risk done'}
            </span>
          )}
        </div>
        <div className="h-1 bg-surface-subtle rounded-full overflow-hidden">
          <div
            className="h-full bg-verified-bar transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Recent changes */}
      <div className="px-4 pt-3 pb-1 flex items-center justify-between shrink-0">
        <p className="text-[10px] text-ink-faint uppercase tracking-[0.1em]">Recent changes</p>
        <p className="text-[10px] font-mono text-ink-faint tabular-nums">
          {history.length} {history.length === 1 ? 'entry' : 'entries'}
        </p>
      </div>

      {!hasHistory ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="w-10 h-10 rounded-full bg-surface-muted border border-border flex items-center justify-center mb-3">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-faint">
              <circle cx="7" cy="7" r="5.5" />
              <path d="M7 4v3l2 1.5" strokeLinecap="round" />
            </svg>
          </div>
          <p className="text-xs text-ink-muted mb-1">No changes yet</p>
          <p className="text-[11px] text-ink-faint leading-snug">
            Edits, deletions, and verifications will appear here in reverse chronological order.
          </p>
        </div>
      ) : (
        <ol className="flex-1 overflow-y-auto min-h-0">
          {history.map((entry) => (
            <li
              key={entry.id}
              className="px-4 py-2.5 text-xs border-b border-border last:border-b-0 hover:bg-surface-muted transition-colors"
            >
              <div className="flex items-baseline justify-between mb-1 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${KIND_DOT[entry.kind]}`} />
                  <span className="text-[11px] text-ink truncate font-medium" title={entry.reviewer}>
                    {entry.reviewer}
                  </span>
                </div>
                <span className="font-mono text-[10px] text-ink-faint tabular-nums shrink-0">
                  {entry.timestamp}
                </span>
              </div>

              <div className="flex items-baseline gap-2 pl-3.5">
                <span className="font-mono text-[10px] text-ink-faint shrink-0">
                  {entry.segmentIds && entry.segmentIds.length > 1
                    ? `segs ${entry.segmentIds.slice(0, 6).join(', ')}${
                        entry.segmentIds.length > 6 ? '…' : ''
                      }`
                    : `seg ${entry.segmentId}${
                        entry.wordIndex !== undefined ? ` · #${entry.wordIndex + 1}` : ''
                      }`}
                </span>
                <div className="text-ink leading-snug">{formatAction(entry)}</div>
              </div>

              {entry.reason && (
                <p className="pl-3.5 mt-1 text-[10px] text-ink-faint italic">
                  ↳ {entry.reason}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}

      {/* Export — secondary task, collapsed by default so the panel reads as a
          reviewer work panel, not an export console. */}
      <div className="border-t border-border px-4 py-2 shrink-0" data-tour="export">
        <button
          onClick={() => setExportOpen((v) => !v)}
          className="w-full flex items-center justify-between text-[10px] text-ink-faint uppercase tracking-[0.1em] hover:text-ink"
        >
          <span>Export</span>
          <svg
            width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
            className={`transition-transform ${exportOpen ? 'rotate-90' : ''}`}
          >
            <path d="M4.5 2.5 8 6l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {exportOpen && (
          <div className="mt-2 space-y-1.5">
            <button
              onClick={() => {
                exportTranscriptReportHtml({ ...exportArgs, history })
                onExport?.('report_html', totalSegments)
              }}
              title="A single, reader-friendly file with the full reviewed transcript and a complete log of what changed, when, and why."
              className="w-full text-xs font-medium px-3 py-1.5 rounded bg-brand text-white hover:bg-brand-dark transition-colors flex items-center justify-center gap-1.5"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M7 1v8m0 0L4 6m3 3l3-3" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M2 11v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" strokeLinecap="round" />
              </svg>
              Download report (HTML)
            </button>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-ink-muted w-20 shrink-0" title="Chronological log of every edit, deletion, and verification.">
                Audit log
              </span>
              <ExportButton label="CSV" disabled={!hasHistory} onClick={() => { exportHistoryAsCSV(history); onExport?.('audit_csv', history.length) }} />
              <ExportButton label="JSON" disabled={!hasHistory} onClick={() => { exportHistoryAsJSON(history); onExport?.('audit_json', history.length) }} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-ink-muted w-20 shrink-0" title="The reviewed transcript itself, with all edits and deletions applied (active model only).">
                Reviewed
              </span>
              <ExportButton label="TXT" onClick={() => { exportTranscriptText(exportArgs); onExport?.('transcript_txt', totalSegments) }} />
              <ExportButton label="JSON" onClick={() => { exportTranscriptJson(exportArgs); onExport?.('transcript_json', totalSegments) }} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-ink-muted w-20 shrink-0" title="The original multi-model pipeline output, unedited. Re-upload it later to reuse this audio without re-transcribing.">
                Original
              </span>
              <ExportButton label="JSON" onClick={() => { exportSourceTranscriptJson({ ...exportArgs, transcript: sourceTranscript ?? transcript }); onExport?.('transcript_source_json', totalSegments) }} />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-ink-muted w-20 shrink-0" title="The exact JSON the transcription backend returned, BEFORE any front-end adaptation (the ASR pipeline's raw nested sentence/confidence format). For a normal backend this equals Original. Use it to archive/inspect each run's untouched output.">
                Pipeline raw
              </span>
              <ExportButton label="JSON" onClick={() => { exportRawPipelineJson(rawSource ?? sourceTranscript ?? transcript, exportArgs); onExport?.('pipeline_raw_json', totalSegments) }} />
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
