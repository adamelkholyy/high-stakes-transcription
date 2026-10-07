import type { AlignedToken, Word } from '../types'

// The ONE tokenizer for a sentence-rewrite override string. alignRewrite and the
// word-candidate splice path (keptTokenPosition) must split identically, or the
// splice lands on the wrong word. Whitespace-split, drop empties.
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

// Normalise for matching: lowercase, drop punctuation but keep apostrophes so
// "don't" still matches "don't" and "Gun." matches "gun". Pure-punctuation
// tokens clean to '' and (by the guard in the LCS) never match anything.
function clean(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9']/g, '')
}

// An inserted run of >= this many words renders/karaokes as ONE block over its
// time gap, instead of per-word interpolation (a whole-clause replacement).
const BLOCK_RUN_THRESHOLD = 3
// Minimum karaoke duration (s) for an interpolated inserted word.
const MIN_INSERT_DUR = 0.08
// If the gap available per inserted word exceeds this (s), it's implausible
// (silence / clause replacement) → block-span instead of stretching per word.
const MAX_PER_WORD_GAP = 1.5

type Op =
  | { type: 'keep'; oi: number; ni: number }
  | { type: 'insert'; ni: number }
  | { type: 'delete'; oi: number }

// LCS over the cleaned keys → an ordered keep/insert/delete op list. A
// substitution falls out as adjacent delete+insert (no 'replace' op needed).
// Empty keys (pure punctuation) never count as equal, so they always insert.
function lcsOps(origKeys: string[], newKeys: string[]): Op[] {
  const n = origKeys.length
  const m = newKeys.length
  const eq = (i: number, j: number) => origKeys[i] !== '' && origKeys[i] === newKeys[j]
  // Suffix LCS table: L[i][j] = LCS length of origKeys[i:] vs newKeys[j:].
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = eq(i, j) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (eq(i, j)) {
      ops.push({ type: 'keep', oi: i, ni: j })
      i++
      j++
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      ops.push({ type: 'delete', oi: i })
      i++
    } else {
      ops.push({ type: 'insert', ni: j })
      j++
    }
  }
  while (i < n) ops.push({ type: 'delete', oi: i++ })
  while (j < m) ops.push({ type: 'insert', ni: j++ })
  return ops
}

// Assign karaoke start/end to each run of consecutive inserted tokens. Kept
// tokens already carry their original word's real times.
function assignInsertTimes(toks: AlignedToken[], segStart: number, segEnd: number): void {
  const hasKeep = toks.some((t) => t.op === 'keep')
  let blockId = 0
  let i = 0
  while (i < toks.length) {
    if (toks[i].op !== 'insert') {
      i++
      continue
    }
    let j = i
    while (j < toks.length && toks[j].op === 'insert') j++
    const run = toks.slice(i, j)
    const runLength = run.length

    // Anchors: previous kept word's end, next kept word's start. A run at the
    // very start/end of the segment anchors to segStart/segEnd. They may be
    // undefined when the originals carry no timestamps.
    const tPrev = i > 0 ? toks[i - 1].end : segStart
    const tNext = j < toks.length ? toks[j].start : segEnd

    // Block grouping is VISUAL and timestamp-independent: a whole-clause
    // replacement (long run) or an all-new segment renders as ONE block. Shared
    // block timing is only applied when timestamps exist (else karaoke skips it).
    let isBlock = !hasKeep || runLength >= BLOCK_RUN_THRESHOLD

    if (tPrev != null && tNext != null) {
      const gap = Math.max(0, tNext - tPrev)
      // Also block when the gap is implausibly large (silence) or too small to
      // hold per-word min durations.
      if (gap / runLength > MAX_PER_WORD_GAP || gap < runLength * MIN_INSERT_DUR) isBlock = true
      if (isBlock) {
        const id = blockId++
        for (const t of run) {
          t.start = tPrev
          t.end = tNext
          t.blockId = id
        }
      } else {
        // Char-weighted interpolation across the gap (monotonic, min-duration).
        const weights = run.map((t) => Math.max(1, t.text.length))
        const total = weights.reduce((a, b) => a + b, 0)
        let c = tPrev
        for (let k = 0; k < run.length; k++) {
          const dur = Math.max(MIN_INSERT_DUR, (gap * weights[k]) / total)
          const e = Math.min(c + dur, tNext)
          run[k].start = c
          run[k].end = e
          c = e
        }
      }
    } else if (isBlock) {
      // No timestamps, but still a visual block (clause replace / all-new on a
      // no-timestamp transcript) — group without times.
      const id = blockId++
      for (const t of run) t.blockId = id
    }
    // else: short run, no times → individual untimed inserts.
    i = j
  }
}

/**
 * Word-level-diff a whole-sentence rewrite against the original words so that
 * UNCHANGED words keep their real per-word risk + timestamps, inserted words
 * get interpolated (or block) times, and deleted words drop. Pure + deterministic
 * — computed at render time; not stored. See AlignedToken.
 */
export function alignRewrite(
  overrideText: string,
  originalWords: Word[],
  segStart: number,
  segEnd: number,
): AlignedToken[] {
  const newToks = tokenize(overrideText)
  if (newToks.length === 0) return []
  const newKeys = newToks.map(clean)
  const origKeys = originalWords.map((w) => clean(w.text))
  const ops = lcsOps(origKeys, newKeys)

  const toks: AlignedToken[] = []
  for (const op of ops) {
    if (op.type === 'keep') {
      const w = originalWords[op.oi]
      toks.push({
        text: newToks[op.ni],
        op: 'keep',
        word: w,
        originalIndex: op.oi,
        start: w.start,
        end: w.end,
      })
    } else if (op.type === 'insert') {
      toks.push({ text: newToks[op.ni], op: 'insert', word: null, originalIndex: null })
    }
    // delete → emit nothing (history records the from→to text)
  }

  assignInsertTimes(toks, segStart, segEnd)
  return toks
}

/**
 * For a rewritten segment (a segmentTextEdits override string), find the token
 * in the override that currently renders original word `originalIndex` as a KEEP
 * token — i.e. the still-unchanged word the reviewer clicked to inspect ASR
 * candidates. `pos` indexes BOTH tokenize(override) and alignRewrite(...)'s
 * output: they are 1:1 because every new token becomes exactly one keep/insert
 * token in order (deletes emit nothing), so toks[k] ↔ tokenize(override)[k].
 *
 * Returns null when that original word is no longer a kept token (it was
 * rewritten away, so no per-model candidate applies) — callers degrade to a
 * no-op. Used to (a) read the currently-displayed word text and (b) splice a
 * chosen candidate / deletion back into the override at the right position.
 */
export function keptTokenPosition(
  override: string,
  originalWords: Word[],
  segStart: number,
  segEnd: number,
  originalIndex: number,
): { pos: number; parts: string[]; token: string } | null {
  const parts = tokenize(override)
  const toks = alignRewrite(override, originalWords, segStart, segEnd)
  const pos = toks.findIndex((t) => t.op === 'keep' && t.originalIndex === originalIndex)
  if (pos < 0 || pos >= parts.length) return null
  return { pos, parts, token: parts[pos] }
}
