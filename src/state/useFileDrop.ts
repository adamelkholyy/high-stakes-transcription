import { useEffect, useRef, useState } from 'react'

// webm/mp4 included so in-browser recordings (Chromium emits webm, Safari mp4)
// and dropped recordings are recognised as audio, not rejected as "unsupported".
const AUDIO_EXT = /\.(wav|mp3|m4a|ogg|flac|aac|webm|mp4)$/i
const JSON_EXT = /\.json$/i

interface Args {
  onAudio: (file: File) => void
  onJson: (file: File) => void
  onError: (msg: string) => void
}

export function useFileDrop({ onAudio, onJson, onError }: Args): boolean {
  const [active, setActive] = useState(false)
  const counter = useRef(0)
  // Latest callbacks in refs so the window listeners stay stable.
  const callbacks = useRef({ onAudio, onJson, onError })
  callbacks.current = { onAudio, onJson, onError }

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      counter.current += 1
      if (counter.current === 1) setActive(true)
    }

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      counter.current = Math.max(0, counter.current - 1)
      if (counter.current === 0) setActive(false)
    }

    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      counter.current = 0
      setActive(false)
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      const cb = callbacks.current
      if (AUDIO_EXT.test(file.name)) cb.onAudio(file)
      else if (JSON_EXT.test(file.name)) cb.onJson(file)
      else cb.onError(`Unsupported file type: ${file.name}`)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return active
}
