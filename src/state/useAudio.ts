import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { makeSilentWav } from '../utils/silentWav'

export interface AudioController {
  containerRef: React.RefObject<HTMLDivElement>
  isPlaying: boolean
  currentTime: number
  duration: number
  ready: boolean
  togglePlay: () => void
  setRate: (rate: number) => void
  seek: (seconds: number) => void
}

interface Options {
  onError?: (msg: string) => void
}

export function useAudio(
  audioBlob: Blob | null,
  fallbackDuration: number,
  options: Options = {},
): AudioController {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [ready, setReady] = useState(false)

  const currentUrlRef = useRef<string | null>(null)
  // Latest callbacks in a ref so we don't tear down wavesurfer on identity churn.
  const callbacksRef = useRef(options)
  callbacksRef.current = options

  // Mount once.
  useEffect(() => {
    if (!containerRef.current) return

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 24,
      // Waveform hidden: the amplitude bars added visual noise without value
      // (and looked different per audio file — flat for the silent placeholder,
      // tall for a real upload). This stays as the still-interactive
      // (click / drag-to-seek) surface, but renders nothing — PlayerBar draws a
      // plain progress rail + knob over it instead.
      waveColor: 'transparent',
      progressColor: 'transparent',
      // No built-in cursor line — the draggable knob overlay (PlayerBar) is the
      // playhead now.
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: false,
      interact: true,
      // Click OR drag to seek; debounceTime 0 = real-time scrubbing (playing
      // and paused). The visible draggable knob is an app-DOM overlay in
      // PlayerBar (wavesurfer renders in a shadow DOM we can't style).
      dragToSeek: { debounceTime: 0 },
    })

    wsRef.current = ws

    const updateTime = (t: number) => setCurrentTime(t)

    ws.on('ready', () => {
      setDuration(ws.getDuration())
      setReady(true)
    })
    ws.on('play', () => {
      setIsPlaying(true)
    })
    ws.on('pause', () => {
      setIsPlaying(false)
    })
    ws.on('finish', () => {
      setIsPlaying(false)
    })
    ws.on('audioprocess', updateTime)
    ws.on('seeking', updateTime)
    ws.on('timeupdate', updateTime)
    ws.on('error', (err) => {
      // A superseded load (new audio, re-mount, StrictMode double-invoke)
      // aborts the in-flight one — not a real failure, so don't surface it.
      const msg = err instanceof Error ? err.message : String(err)
      const aborted =
        (err instanceof Error && err.name === 'AbortError') || /abort/i.test(msg)
      if (aborted) return
      callbacksRef.current.onError?.(`Audio failed to load: ${msg}`)
    })

    return () => {
      ws.destroy()
      wsRef.current = null
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current)
        currentUrlRef.current = null
      }
    }
  }, [])

  // Load source: own the object URL lifecycle.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return

    setReady(false)
    setIsPlaying(false)
    setCurrentTime(0)

    const blob = audioBlob ?? makeSilentWav(fallbackDuration)
    const newUrl = URL.createObjectURL(blob)
    const prevUrl = currentUrlRef.current
    currentUrlRef.current = newUrl

    let cancelled = false

    ws.load(newUrl)
      .then(() => {
        if (cancelled) return
        if (prevUrl && prevUrl !== currentUrlRef.current) {
          URL.revokeObjectURL(prevUrl)
        }
      })
      .catch((err) => {
        if (cancelled) return
        // A superseded load (new audio, re-mount, or StrictMode double-invoke)
        // rejects the in-flight one with an abort — that is not a real failure,
        // so don't surface it as an error banner.
        const msg = err instanceof Error ? err.message : String(err)
        const aborted =
          (err instanceof Error && err.name === 'AbortError') || /abort/i.test(msg)
        if (aborted) return
        callbacksRef.current.onError?.(`Audio failed to load: ${msg}`)
        if (currentUrlRef.current === newUrl) {
          URL.revokeObjectURL(newUrl)
          currentUrlRef.current = prevUrl
        }
      })

    return () => {
      cancelled = true
      if (currentUrlRef.current !== newUrl) {
        URL.revokeObjectURL(newUrl)
      }
    }
  }, [audioBlob, fallbackDuration])

  return {
    containerRef,
    isPlaying,
    currentTime,
    duration,
    ready,
    togglePlay: () => wsRef.current?.playPause(),
    setRate: (rate) => wsRef.current?.setPlaybackRate(rate, true),
    seek: (seconds) => {
      const ws = wsRef.current
      if (!ws) return
      const d = ws.getDuration()
      if (d > 0) ws.seekTo(Math.max(0, Math.min(seconds / d, 1)))
    },
  }
}
