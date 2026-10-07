import { useEffect } from 'react'
import type { Transcript } from '../types'

interface Args {
  transcript: Transcript
  currentTime: number
  togglePlay: () => void
  seek: (seconds: number) => void
  toggleVerify?: (segId: number) => void
  replaySegment: () => void
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
}

export function useKeyboardShortcuts({
  transcript,
  currentTime,
  togglePlay,
  seek,
  toggleVerify,
  replaySegment,
}: Args) {
  useEffect(() => {
    const activeSegmentId = (): number | null => {
      const seg = transcript.segments.find(
        (s) => currentTime >= s.start && currentTime < s.end,
      )
      return seg?.id ?? null
    }

    const prevSegmentStart = (): number => {
      const reversed = [...transcript.segments].reverse()
      const target = reversed.find((s) => s.start < currentTime - 0.5)
      return (target ?? transcript.segments[0]).start
    }

    const nextSegmentStart = (): number => {
      const target = transcript.segments.find((s) => s.start > currentTime + 0.1)
      return (target ?? transcript.segments[transcript.segments.length - 1]).start
    }

    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          togglePlay()
          return
        case 'ArrowLeft':
          e.preventDefault()
          seek(Math.max(0, currentTime - 5))
          return
        case 'ArrowRight':
          e.preventDefault()
          seek(Math.min(transcript.audioDuration, currentTime + 5))
          return
      }

      switch (e.key.toLowerCase()) {
        case 'j':
          e.preventDefault()
          seek(prevSegmentStart())
          return
        case 'k':
          e.preventDefault()
          seek(nextSegmentStart())
          return
        case 'v': {
          if (!toggleVerify) return
          const id = activeSegmentId()
          if (id !== null) {
            e.preventDefault()
            toggleVerify(id)
            // Shift+V = verify and advance to the next segment.
            if (e.shiftKey) seek(nextSegmentStart())
          }
          return
        }
        case 'r':
          e.preventDefault()
          replaySegment()
          return
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [transcript, currentTime, togglePlay, seek, toggleVerify, replaySegment])
}
