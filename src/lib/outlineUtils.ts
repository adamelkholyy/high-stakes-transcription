// Shared helpers for the Outline views (docked panel + full-screen storyboard).

// Item (Part or Chapter) whose start is the greatest one ≤ t — i.e. the one the
// playhead currently sits in. Returns null if t is before everything.
export function findCurrentId(
  items: { id: number; segment_start: number; segment_end: number }[],
  t: number,
): number | null {
  let best: number | null = null
  for (const it of items) {
    if (it.segment_start <= t + 0.001) best = it.id
    else break
  }
  return best
}

export function match(s: string, q: string): boolean {
  return (s || '').toLowerCase().includes(q)
}

export function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function fmtDuration(seconds: number): string {
  const sec = Math.max(0, Math.round(seconds))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return s === 0 ? `${m}m` : `${m}m ${s}s`
  return `${s}s`
}
