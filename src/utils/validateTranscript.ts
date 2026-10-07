import type { Transcript } from '../types'

export type ValidationResult =
  | { ok: true; transcript: Transcript }
  | { ok: false; error: string }

const RISKS = new Set(['high', 'med', 'low'])

function fail(error: string): ValidationResult {
  return { ok: false, error }
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

export function validateTranscript(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('Top-level JSON must be an object with audioDuration and segments.')
  }
  const v = value as Record<string, unknown>

  if (!isFiniteNumber(v.audioDuration) || v.audioDuration <= 0) {
    return fail('audioDuration must be a positive finite number (seconds).')
  }

  if (!Array.isArray(v.segments) || v.segments.length === 0) {
    return fail('segments must be a non-empty array.')
  }

  const seenIds = new Set<number>()
  let firstModelKeys: string[] | null = null

  for (let i = 0; i < v.segments.length; i++) {
    const s = v.segments[i] as Record<string, unknown>
    const path = `segments[${i}]`
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return fail(`${path} must be an object.`)
    }

    if (!isFiniteNumber(s.id)) return fail(`${path}.id must be a number.`)
    if (seenIds.has(s.id as number)) {
      return fail(`${path}.id (${s.id}) is duplicated — segment ids must be unique.`)
    }
    seenIds.add(s.id as number)

    // `speaker` can be any non-empty string — Whisper-only pipelines emit
    // a generic "Speaker", diarized pipelines emit per-turn names.
    if (typeof s.speaker !== 'string' || s.speaker.trim() === '') {
      return fail(`${path}.speaker must be a non-empty string.`)
    }
    if (!isFiniteNumber(s.start) || !isFiniteNumber(s.end)) {
      return fail(`${path}.start and ${path}.end must be finite numbers.`)
    }
    if ((s.start as number) < 0 || (s.end as number) <= (s.start as number)) {
      return fail(`${path}: require 0 ≤ start < end. Got start=${s.start}, end=${s.end}.`)
    }
    if ((s.end as number) > (v.audioDuration as number) + 0.5) {
      return fail(
        `${path}.end (${s.end}) exceeds audioDuration (${v.audioDuration}).`,
      )
    }
    if (typeof s.paraRisk !== 'string' || !RISKS.has(s.paraRisk)) {
      return fail(`${path}.paraRisk must be 'high', 'med', or 'low'.`)
    }
    if (!s.words || typeof s.words !== 'object' || Array.isArray(s.words)) {
      return fail(`${path}.words must be an object keyed by model name.`)
    }

    const modelEntries = Object.entries(s.words as Record<string, unknown>)
    if (modelEntries.length === 0) {
      return fail(`${path}.words must declare at least one model.`)
    }

    const modelKeys = modelEntries.map(([k]) => k)
    if (firstModelKeys === null) {
      firstModelKeys = modelKeys
    } else {
      // All segments should declare the same model keys, otherwise the model
      // dropdown will silently miss words on some segments.
      const missing = firstModelKeys.filter((k) => !modelKeys.includes(k))
      if (missing.length > 0) {
        return fail(
          `${path}.words is missing model key(s): ${missing.join(', ')}. All segments must share the same model keys.`,
        )
      }
    }

    for (const [modelKey, arr] of modelEntries) {
      if (!Array.isArray(arr)) {
        return fail(`${path}.words["${modelKey}"] must be an array.`)
      }
      for (let j = 0; j < arr.length; j++) {
        const wd = arr[j] as Record<string, unknown>
        const wpath = `${path}.words["${modelKey}"][${j}]`
        if (!wd || typeof wd !== 'object' || Array.isArray(wd)) {
          return fail(`${wpath} must be an object.`)
        }
        if (typeof wd.text !== 'string') return fail(`${wpath}.text must be a string.`)
        if (typeof wd.risk !== 'string' || !RISKS.has(wd.risk)) {
          return fail(`${wpath}.risk must be 'high', 'med', or 'low'.`)
        }
        if (wd.alternatives !== undefined) {
          if (
            !Array.isArray(wd.alternatives) ||
            wd.alternatives.some((a) => typeof a !== 'string')
          ) {
            return fail(`${wpath}.alternatives must be an array of strings if present.`)
          }
        }
      }
    }
  }

  return { ok: true, transcript: value as Transcript }
}
