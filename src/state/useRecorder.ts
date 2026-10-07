import { useCallback, useEffect, useRef, useState } from 'react'

export interface RecorderController {
  isRecording: boolean
  elapsedMs: number
  supported: boolean
  start: () => Promise<void>
  stop: () => Promise<{ blob: Blob; mimeType: string } | null>
}

interface Options {
  onError?: (msg: string) => void
}

// Pick the first MIME type the browser actually supports. Order matters:
// webm/opus is what Chromium produces; Safari prefers mp4/aac.
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const t of PREFERRED_TYPES) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

export function extensionForMime(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'm4a'
  return 'bin'
}

export function useRecorder(options: Options = {}): RecorderController {
  const supported =
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia

  const [isRecording, setIsRecording] = useState(false)
  const [elapsedMs, setElapsedMs] = useState(0)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const tickRef = useRef<number | null>(null)
  const startedAtRef = useRef<number>(0)
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  // Clean up any active recording on unmount.
  useEffect(() => {
    return () => {
      if (tickRef.current != null) {
        window.clearInterval(tickRef.current)
        tickRef.current = null
      }
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop()
        } catch {
          /* noop */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      recorderRef.current = null
    }
  }, [])

  const start = useCallback(async () => {
    if (!supported) {
      callbacksRef.current.onError?.(
        'Recording is not supported in this browser.',
      )
      return
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      const err = e as DOMException
      let msg = 'Microphone access denied.'
      if (err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError') {
        msg = 'No microphone found.'
      } else if (
        err?.name === 'NotAllowedError' ||
        err?.name === 'PermissionDeniedError'
      ) {
        msg = 'Microphone access denied.'
      } else if (err?.message) {
        msg = `Microphone unavailable: ${err.message}`
      }
      callbacksRef.current.onError?.(msg)
      return
    }

    const mimeType = pickMimeType()
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)

    chunksRef.current = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }

    streamRef.current = stream
    recorderRef.current = recorder
    startedAtRef.current = performance.now()
    setElapsedMs(0)

    tickRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAtRef.current)
    }, 250)

    recorder.start()
    setIsRecording(true)
  }, [supported])

  const stop = useCallback((): Promise<{ blob: Blob; mimeType: string } | null> => {
    const recorder = recorderRef.current
    const stream = streamRef.current
    if (!recorder || recorder.state === 'inactive') {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []

        stream?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        recorderRef.current = null

        if (tickRef.current != null) {
          window.clearInterval(tickRef.current)
          tickRef.current = null
        }
        setIsRecording(false)
        resolve({ blob, mimeType })
      }
      recorder.stop()
    })
  }, [])

  return { isRecording, elapsedMs, supported, start, stop }
}
