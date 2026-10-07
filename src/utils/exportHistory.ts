import type { HistoryEntry } from '../types'

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

function csvEscape(value: string | number | undefined): string {
  if (value === undefined || value === null) return ''
  const s = String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function exportHistoryAsCSV(history: HistoryEntry[]): void {
  const header = [
    'timestamp',
    'reviewer',
    'kind',
    'segment_id',
    'word_index',
    'from',
    'to',
    'reason',
  ]
  // History is newest-first in state; export oldest-first so the file reads
  // chronologically top → bottom.
  const rows = [...history].reverse().map((e) => [
    e.timestamp,
    e.reviewer,
    e.kind,
    e.segmentIds ? e.segmentIds.join(';') : e.segmentId,
    e.wordIndex ?? '',
    e.from ?? '',
    e.kind === 'delete' ? '(deleted)' : e.to ?? '',
    e.reason ?? '',
  ])
  const csv = [header, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\n')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadBlob(`audit-trail-${stamp}.csv`, csv, 'text/csv;charset=utf-8')
}

export function exportHistoryAsJSON(history: HistoryEntry[]): void {
  const ordered = [...history].reverse()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const payload = {
    exported_at: new Date().toISOString(),
    entry_count: ordered.length,
    entries: ordered,
  }
  downloadBlob(
    `audit-trail-${stamp}.json`,
    JSON.stringify(payload, null, 2),
    'application/json',
  )
}
