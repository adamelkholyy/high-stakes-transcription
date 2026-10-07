// Local backend base URLs.
//
//   local dev (default): model API on :8000, ASR on :8001 (127.0.0.1, not
//     "localhost", so an IPv6 ::1 squatter can't intercept — see predictApi).
// One import point for every *Api.ts, so there is a single place to repoint the
// backend. Trailing slashes are trimmed so `${API_BASE}/predict`
// is always well-formed.
const trim = (u: string) => u.replace(/\/+$/, '')

export const API_BASE = trim(import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8000')
export const ASR_BASE = trim(import.meta.env.VITE_ASR_BASE ?? 'http://127.0.0.1:8001')

// The independent local ASR ensemble is optional. Disable it to use the frozen
// demo case and transcript-JSON import without loading speech models.
export const ASR_ENABLED = (import.meta.env.VITE_ASR_ENABLED ?? 'true') !== 'false'
