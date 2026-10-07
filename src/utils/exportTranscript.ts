import type { EditState, HistoryEntry, ModelName, Transcript } from '../types'
import { alignRewrite } from '../lib/retainRisk'

interface ExportArgs {
  transcript: Transcript
  model: ModelName
  edits: Record<string, EditState>
  segmentTextEdits?: Record<number, { text: string; reason?: string }>
  verified: Record<number, boolean>
  reviewer: string
  audioFilename: string | null
  transcriptFilename: string | null
}

interface ReportArgs extends ExportArgs {
  history: HistoryEntry[]
}

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function fileStem(args: ExportArgs): string {
  const source = args.audioFilename ?? args.transcriptFilename ?? 'transcript'
  return source.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_')
}

function isoStamp(): string {
  return new Date().toISOString()
}

function safeFsStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function verifiedCount(verified: Record<number, boolean>): number {
  return Object.values(verified).filter(Boolean).length
}

// --------------------------------------------------------------------------

export function exportTranscriptText(args: ExportArgs): void {
  const { transcript, model, edits, segmentTextEdits, verified, reviewer } = args
  const totalSegments = transcript.segments.length
  const verifiedN = verifiedCount(verified)

  const lines: string[] = []
  lines.push('REVIEWED TRANSCRIPT')
  lines.push('===================')
  lines.push(`Case:      ${args.audioFilename ?? 'interview_2024-03-14_case447.wav'}`)
  if (args.transcriptFilename) {
    lines.push(`Source:    ${args.transcriptFilename}`)
  }
  lines.push(`Reviewer:  ${reviewer.trim() || 'Unknown reviewer'}`)
  lines.push(`Model:     ${model}`)
  lines.push(`Verified:  ${verifiedN} / ${totalSegments} segments`)
  lines.push(`Exported:  ${isoStamp()}`)
  lines.push('')
  lines.push('-'.repeat(72))
  lines.push('')

  for (const seg of transcript.segments) {
    const words = seg.words[model] ?? []
    const renderedWords: string[] = []
    for (let i = 0; i < words.length; i++) {
      const edit = edits[`${seg.id}-${i}`]
      if (edit?.deleted) {
        renderedWords.push('[removed]')
      } else if (edit) {
        renderedWords.push(edit.text)
      } else {
        renderedWords.push(words[i].text)
      }
    }
    const verifiedTag = verified[seg.id] ? '  (✓ verified)' : ''
    const override = segmentTextEdits?.[seg.id]?.text
    lines.push(`[${formatTime(seg.start)}] ${seg.speaker.toUpperCase()}:${verifiedTag}`)
    lines.push(`  ${override ?? renderedWords.join(' ')}`)
    lines.push('')
  }

  lines.push('-'.repeat(72))
  lines.push('End of transcript.')
  lines.push('')

  downloadBlob(
    `transcript-${fileStem(args)}-${safeFsStamp()}.txt`,
    lines.join('\n'),
    'text/plain;charset=utf-8',
  )
}

// --------------------------------------------------------------------------

interface ExportedWord {
  text: string
  risk: 'high' | 'med' | 'low'
  alternatives?: string[]
  edited?: boolean
  deleted?: boolean
  original_text?: string
  reason?: string
}

// Word-level diff of a whole-sentence rewrite vs the original words (matches what
// the reviewer saw on screen) — kept words carry their original risk; inserts are
// human-authored. Phase-2 / analysis friendly; parallels reviewed_text.
interface ExportedAlignedWord {
  text: string
  op: 'keep' | 'insert'
  risk?: 'high' | 'med' | 'low'
  original_index?: number
  start?: number
  end?: number
  block_id?: number
}

interface ExportedSegment {
  id: number
  speaker: string
  start: number
  end: number
  paraRisk: 'high' | 'med' | 'low'
  verified: boolean
  reviewed_text?: string   // #1 whole-sentence rewrite (supersedes per-word)
  reviewed_words?: ExportedAlignedWord[]  // word-level diff of the rewrite
  words: { [modelName: string]: ExportedWord[] }
}

export function exportTranscriptJson(args: ExportArgs): void {
  const { transcript, model, edits, segmentTextEdits, verified, reviewer } = args
  const totalSegments = transcript.segments.length
  const verifiedN = verifiedCount(verified)

  const segments: ExportedSegment[] = transcript.segments.map((seg) => {
    const sourceWords = seg.words[model] ?? []
    const reviewedWords: ExportedWord[] = sourceWords.map((w, i) => {
      const edit = edits[`${seg.id}-${i}`]
      if (!edit) {
        const out: ExportedWord = { text: w.text, risk: w.risk }
        if (w.alternatives) out.alternatives = w.alternatives
        return out
      }
      const out: ExportedWord = {
        text: edit.text,
        risk: w.risk,
        edited: true,
        original_text: w.text,
      }
      if (w.alternatives) out.alternatives = w.alternatives
      if (edit.deleted) out.deleted = true
      if (edit.reason) out.reason = edit.reason
      return out
    })

    const out: ExportedSegment = {
      id: seg.id,
      speaker: seg.speaker,
      start: seg.start,
      end: seg.end,
      paraRisk: seg.paraRisk,
      verified: !!verified[seg.id],
      words: { [model]: reviewedWords },
    }
    const override = segmentTextEdits?.[seg.id]?.text
    if (override) {
      out.reviewed_text = override
      out.reviewed_words = alignRewrite(override, sourceWords, seg.start, seg.end).map((t) => {
        const a: ExportedAlignedWord = { text: t.text, op: t.op }
        if (t.op === 'keep' && t.word) a.risk = t.word.risk
        if (t.originalIndex != null) a.original_index = t.originalIndex
        if (t.start != null) a.start = t.start
        if (t.end != null) a.end = t.end
        if (t.blockId != null) a.block_id = t.blockId
        return a
      })
    }
    return out
  })

  const payload = {
    metadata: {
      reviewer: reviewer.trim() || 'Unknown reviewer',
      exported_at: isoStamp(),
      base_model: model,
      verified_count: verifiedN,
      total_segments: totalSegments,
      source_audio: args.audioFilename ?? null,
      source_transcript: args.transcriptFilename ?? null,
    },
    audioDuration: transcript.audioDuration,
    segments,
  }

  downloadBlob(
    `transcript-${fileStem(args)}-${safeFsStamp()}.json`,
    JSON.stringify(payload, null, 2),
    'application/json',
  )
}

// --------------------------------------------------------------------------
// Original (source) transcript — the full multi-model pipeline output exactly
// as loaded, with every model branch and the predicted_* fields, unedited.
// Schema-valid, so the Upload Transcript button accepts it: re-load this later
// to reuse the same audio without re-running the ASR models.
export function exportSourceTranscriptJson(args: ExportArgs): void {
  downloadBlob(
    `transcript-source-${fileStem(args)}-${safeFsStamp()}.json`,
    JSON.stringify(args.transcript, null, 2),
    'application/json',
  )
}

// --------------------------------------------------------------------------
// Raw ASR-backend output — the exact JSON the transcription backend returned,
// BEFORE any front-end adaptation. For the teammate's ASR pipeline this is the
// nested { segments: [{ sentences: [...] }] } shape with the selector's raw
// per-sentence confidence/score/alignment; for a normal backend that already
// speaks our schema, `rawSource` IS the transcript, so this equals "Original".
// Purpose: archive/inspect each run's untouched backend output (diagnose the
// pipeline vs. the adapter).
export function exportRawPipelineJson(rawSource: unknown, args: ExportArgs): void {
  downloadBlob(
    `pipeline-raw-${fileStem(args)}-${safeFsStamp()}.json`,
    JSON.stringify(rawSource, null, 2),
    'application/json',
  )
}

// --------------------------------------------------------------------------
// Human-readable single-file HTML report.
//
// One self-contained .html (all CSS/JS inlined, no external deps) intended for
// non-technical readers. It bundles the two deliverables the reviewer's
// requested into a single file:
//   1. the full, up-to-date transcript (with a "clean view <-> show changes"
//      toggle, styled like familiar word-processor tracked changes), and
//   2. a chronological change log — what was changed, when, by whom, and why,
//      from the start of the session to now.
// Open in any browser; print to PDF from there if a static copy is needed.
// --------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const KIND_LABEL: Record<HistoryEntry['kind'], string> = {
  edit: 'Edited',
  delete: 'Removed',
  verify: 'Verified',
  unverify: 'Un-verified',
  split: 'Split',
  merge: 'Merged',
  speaker: 'Speaker',
}

function changeCell(entry: HistoryEntry): string {
  const from = escapeHtml(entry.from || '∅')
  const to = entry.to ? escapeHtml(entry.to) : ''
  switch (entry.kind) {
    case 'edit':
      return `<span class="old">${from}</span> <span class="arrow">→</span> <span class="new">${to}</span>`
    case 'delete':
      return `<span class="old">${from}</span> <span class="arrow">→</span> <span class="removed">(removed)</span>`
    case 'split':
      return `<span class="muted">Split segment ${to}</span>`
    case 'merge':
      return `<span class="muted">Merged ${to}</span>`
    case 'speaker':
      return `<span class="old">${from}</span> <span class="arrow">→</span> <span class="new">${to}</span>`
    case 'verify':
      return `<span class="verified">Marked ${
        entry.segmentIds && entry.segmentIds.length > 1 ? `${entry.segmentIds.length} segments` : 'segment'
      } as verified</span>`
    default:
      return `<span class="unverified">Marked ${
        entry.segmentIds && entry.segmentIds.length > 1 ? `${entry.segmentIds.length} segments` : 'segment'
      } as not verified</span>`
  }
}

export function exportTranscriptReportHtml(args: ReportArgs): void {
  downloadBlob(
    `transcript-report-${fileStem(args)}-${safeFsStamp()}.html`,
    buildTranscriptReportHtml(args),
    'text/html;charset=utf-8',
  )
}

// Pure builder (no DOM side-effects) so the markup can be unit-tested.
export function buildTranscriptReportHtml(args: ReportArgs): string {
  const { transcript, model, edits, segmentTextEdits, verified, reviewer, history } = args
  const totalSegments = transcript.segments.length
  const verifiedN = verifiedCount(verified)
  // Whole-sentence rewrites clear their segment's per-word edits (editSentence),
  // so they're absent from `edits` — count them separately or the summary reads
  // "0 changes" while the body + change log show the rewrites.
  const editCount = Object.keys(edits).length + Object.keys(segmentTextEdits ?? {}).length
  const deletionCount = Object.values(edits).filter((e) => e.deleted).length

  // Look-up tables so the change log can show where each change happened.
  const segById = new Map(transcript.segments.map((s) => [s.id, s]))

  // ---- Transcript body (edited words carry both old + new for the toggle) ----
  const segmentsHtml = transcript.segments
    .map((seg) => {
      const words = seg.words[model] ?? []
      const wordsHtml = words
        .map((w, i) => {
          const edit = edits[`${seg.id}-${i}`]
          const original = escapeHtml(w.text)
          if (edit?.deleted) {
            return `<span class="w deleted"><span class="old">${original}</span></span>`
          }
          if (edit && edit.text !== w.text) {
            return `<span class="w edited"><span class="old">${original}</span><span class="new">${escapeHtml(edit.text)}</span></span>`
          }
          return `<span class="w">${original}</span>`
        })
        .join(' ')
      const verifiedTag = verified[seg.id]
        ? '<span class="seg-verified">✓ verified</span>'
        : ''
      const override = segmentTextEdits?.[seg.id]?.text
      const bodyHtml = override
        ? `<span class="w edited"><span class="old">${escapeHtml(words.map((w) => w.text).join(' '))}</span><span class="new">${escapeHtml(override)}</span></span>`
        : wordsHtml
      return `<div class="seg">
        <div class="seg-head"><span class="seg-time">[${formatTime(seg.start)}]</span> <span class="seg-speaker">${escapeHtml(seg.speaker.toUpperCase())}</span>${verifiedTag}</div>
        <div class="seg-body">${bodyHtml}</div>
      </div>`
    })
    .join('\n')

  // ---- Change log (chronological: oldest first) ----
  const chronological = [...history].reverse()
  const changeRows = chronological
    .map((entry, idx) => {
      const seg = segById.get(entry.segmentId)
      const loc =
        entry.segmentIds && entry.segmentIds.length > 1
          ? `${entry.segmentIds.length} segments`
          : seg
            ? `[${formatTime(seg.start)}] ${escapeHtml(seg.speaker.toUpperCase())}`
            : `segment ${entry.segmentId}`
      const reason = entry.reason ? escapeHtml(entry.reason) : '<span class="muted">—</span>'
      return `<tr>
        <td class="num">${idx + 1}</td>
        <td class="time">${escapeHtml(entry.timestamp)}</td>
        <td>${escapeHtml(entry.reviewer)}</td>
        <td class="loc">${loc}</td>
        <td><span class="kind kind-${entry.kind}">${KIND_LABEL[entry.kind]}</span></td>
        <td class="change">${changeCell(entry)}</td>
        <td class="reason">${reason}</td>
      </tr>`
    })
    .join('\n')

  const changeLog = chronological.length
    ? `<table class="changelog">
        <thead><tr>
          <th>#</th><th>When</th><th>Reviewer</th><th>Location</th><th>Action</th><th>Change</th><th>Reason</th>
        </tr></thead>
        <tbody>${changeRows}</tbody>
      </table>`
    : '<p class="empty">No changes were made — this is the original transcript as produced by the model.</p>'

  const reviewerName = escapeHtml(reviewer.trim() || 'Unknown reviewer')
  const caseName = escapeHtml(args.audioFilename ?? 'interview_2024-03-14_case447.wav')
  const sourceLine = args.transcriptFilename
    ? `<div><dt>Source file</dt><dd>${escapeHtml(args.transcriptFilename)}</dd></div>`
    : ''

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reviewed transcript — ${caseName}</title>
<style>
  :root {
    --ink: #1a1a1a; --muted: #6b7280; --faint: #9ca3af;
    --line: #e5e7eb; --bg: #f8f9fa; --accent: #2563eb;
    --add: #15803d; --del: #b91c1c; --verified: #047857;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--ink); line-height: 1.6; margin: 0; background: var(--bg);
  }
  .page { max-width: 820px; margin: 0 auto; padding: 40px 32px 80px; background: #fff; min-height: 100vh; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--ink); }
  .subtitle { color: var(--muted); font-size: 13px; margin: 0 0 24px; }

  .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 32px;
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 16px 20px; font-size: 13px; }
  .summary dt { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .summary dd { margin: 0 0 8px; font-weight: 600; }

  .legend { font-size: 12px; color: var(--muted); margin: 12px 0 0; display: flex; gap: 18px; flex-wrap: wrap; align-items: center; }
  .legend .old { text-decoration: line-through; color: var(--del); }
  .legend .new { color: var(--add); font-weight: 600; }

  .toolbar { position: sticky; top: 0; background: rgba(255,255,255,.95); backdrop-filter: blur(4px);
    padding: 10px 0; margin: 8px 0 0; border-bottom: 1px solid var(--line); z-index: 5; display: flex; align-items: center; gap: 12px; }
  .toolbar button { font: inherit; font-size: 13px; padding: 6px 14px; border: 1px solid var(--line);
    background: #fff; border-radius: 6px; cursor: pointer; }
  .toolbar button.active { background: var(--ink); color: #fff; border-color: var(--ink); }
  .toolbar .hint { font-size: 12px; color: var(--faint); }

  .seg { margin: 0 0 16px; }
  .seg-head { font-size: 12px; color: var(--muted); margin-bottom: 2px; }
  .seg-time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--faint); }
  .seg-speaker { font-weight: 700; color: var(--ink); letter-spacing: .03em; }
  .seg-verified { color: var(--verified); font-weight: 600; margin-left: 8px; }
  .seg-body { font-size: 15px; }

  /* Edited / deleted word rendering, toggled by body.show-changes */
  .w.edited .old, .w.deleted .old { display: none; }
  .w.edited .new { border-bottom: 1.5px dotted var(--accent); }
  body.show-changes .w.edited .old { display: inline; text-decoration: line-through; color: var(--del); margin-right: 3px; }
  body.show-changes .w.edited .new { color: var(--add); font-weight: 600; border-bottom: none; }
  body.show-changes .w.deleted { display: inline; }
  body.show-changes .w.deleted .old { display: inline; text-decoration: line-through; color: var(--del); }
  .w.deleted { display: none; }

  table.changelog { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px; }
  .changelog th { text-align: left; background: var(--bg); border-bottom: 2px solid var(--line);
    padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .changelog td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .changelog .num { color: var(--faint); }
  .changelog .time, .changelog .loc { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; color: var(--muted); }
  .changelog .old { text-decoration: line-through; color: var(--del); }
  .changelog .new { color: var(--add); font-weight: 600; }
  .changelog .arrow { color: var(--faint); }
  .changelog .removed { color: var(--del); font-weight: 600; }
  .changelog .verified { color: var(--verified); }
  .changelog .reason { color: var(--muted); font-style: italic; }
  .kind { font-size: 11px; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
  .kind-edit { background: #dbeafe; color: #1d4ed8; }
  .kind-delete { background: #fee2e2; color: var(--del); }
  .kind-verify { background: #d1fae5; color: var(--verified); }
  .kind-unverify { background: #f3f4f6; color: var(--muted); }
  .kind-split, .kind-merge { background: #fef3c7; color: #b45309; }
  .kind-speaker { background: #ede9fe; color: #6d28d9; }
  .muted { color: var(--faint); }
  .empty { color: var(--muted); font-style: italic; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 11px; color: var(--faint); }

  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    body.show-changes .page { } /* printed state follows whatever is on screen */
    .page { max-width: none; padding: 0; }
  }
</style>
</head>
<body>
  <div class="page">
    <h1>Reviewed transcript</h1>
    <p class="subtitle">A human-checked version of the automatic transcript, with a full record of every change.</p>

    <dl class="summary">
      <div><dt>Case</dt><dd>${caseName}</dd></div>
      ${sourceLine}
      <div><dt>Reviewer</dt><dd>${reviewerName}</dd></div>
      <div><dt>Transcription model</dt><dd>${escapeHtml(model)}</dd></div>
      <div><dt>Segments verified</dt><dd>${verifiedN} / ${totalSegments}</dd></div>
      <div><dt>Changes made</dt><dd>${editCount} (${deletionCount} removed)</dd></div>
      <div><dt>Exported</dt><dd>${escapeHtml(new Date().toLocaleString())}</dd></div>
    </dl>

    <p class="legend">
      <span><strong>Legend:</strong></span>
      <span><span class="old">old text</span> = original</span>
      <span><span class="new">new text</span> = reviewer's correction</span>
      <span>✓ verified = segment checked against audio</span>
    </p>

    <h2>Transcript</h2>
    <div class="toolbar">
      <button id="btn-clean" class="active" onclick="setView(false)">Clean version</button>
      <button id="btn-changes" onclick="setView(true)">Show changes</button>
      <span class="hint">Tip: print this page (Ctrl/Cmd+P) to save a PDF copy.</span>
    </div>
    ${segmentsHtml}

    <h2>What was changed, and when</h2>
    <p class="subtitle">Every edit, removal, and verification, in the order it happened.</p>
    ${changeLog}

    <div class="footer">
      Generated by the transcript review tool · ${escapeHtml(new Date().toISOString())}
    </div>
  </div>
  <script>
    function setView(showChanges) {
      document.body.classList.toggle('show-changes', showChanges);
      document.getElementById('btn-clean').classList.toggle('active', !showChanges);
      document.getElementById('btn-changes').classList.toggle('active', showChanges);
    }
  </script>
</body>
</html>`

  return html
}
