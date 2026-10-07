import type { ReactNode } from 'react'
import type { AudioController } from '../state/useAudio'

interface Props {
  audio: AudioController
  onSpeedChange?: (speed: number) => void
  /** Hide the playback-rate selector while retaining the trailing controls. */
  showSpeed?: boolean
  // Play/pause with the auto-rewind-on-resume convention; falls back to the raw
  // audio toggle when not provided.
  onTogglePlay?: () => void
  // Relative seek for the ±10s buttons, matching the arrow-key shortcuts;
  // falls back to a raw clamped audio.seek when absent.
  onSkip?: (deltaSeconds: number) => void
  /** Rendered at the far right of the bar, after the Speed control. */
  trailing?: ReactNode
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Page-bottom playback bar (à la Otter): the transport + scrubbable waveform
// stretched across the middle, speed on the right. Pinned to the bottom of the
// workspace column. (Reviewer identity moved up to the top bar.)
export default function PlayerBar({
  audio,
  onSpeedChange,
  showSpeed = true,
  onTogglePlay,
  onSkip,
  trailing,
}: Props) {
  const skip = (delta: number) => {
    if (onSkip) onSkip(delta)
    else audio.seek(Math.max(0, Math.min(audio.duration, audio.currentTime + delta)))
  }

  return (
    <div
      className="h-14 grid grid-cols-[1fr_auto_1fr] items-center px-5 bg-surface border-t border-border shrink-0"
      data-tour="player"
    >
      {/* Empty left cell keeps the transport centred by the 1fr/auto/1fr grid
          (reviewer identity moved to the top bar). */}
      <div aria-hidden />

      {/* Transport cluster — perfectly centred by the 1fr/auto/1fr grid */}
      <div className="flex items-center gap-2 justify-self-center">
      <button
        onClick={() => skip(-10)}
        disabled={!audio.ready}
        aria-label="Back 10 seconds"
        title="Back 10 seconds"
        className="w-8 h-8 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-surface-muted disabled:opacity-40 transition-colors shrink-0"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <text x="12" y="15.5" fontSize="8.5" fontWeight="700" fill="currentColor" stroke="none" textAnchor="middle">10</text>
        </svg>
      </button>
      <button
        onClick={onTogglePlay ?? audio.togglePlay}
        disabled={!audio.ready}
        aria-label={audio.isPlaying ? 'Pause' : 'Play'}
        className="w-8 h-8 flex items-center justify-center rounded border border-border text-ink hover:bg-surface-muted disabled:opacity-40 transition-colors shrink-0"
      >
        {audio.isPlaying ? (
          <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
            <rect x="0" y="0" width="3" height="12" />
            <rect x="7" y="0" width="3" height="12" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <polygon points="2,1 11,6 2,11" />
          </svg>
        )}
      </button>
      <button
        onClick={() => skip(10)}
        disabled={!audio.ready}
        aria-label="Forward 10 seconds"
        title="Forward 10 seconds"
        className="w-8 h-8 flex items-center justify-center rounded text-ink-muted hover:text-ink hover:bg-surface-muted disabled:opacity-40 transition-colors shrink-0"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <text x="12" y="15.5" fontSize="8.5" fontWeight="700" fill="currentColor" stroke="none" textAnchor="middle">10</text>
        </svg>
      </button>

      <span className="font-mono text-xs text-ink-muted w-10 text-right tabular-nums shrink-0">
        {formatTime(audio.currentTime)}
      </span>
      {/* Shorter, centred waveform + a YouTube-style draggable scrubber knob.
          The knob is a pure-visual app-DOM overlay (wavesurfer renders in a
          shadow DOM); pointer-events-none so wavesurfer's own drag-to-seek
          underneath still gets every click/drag. */}
      <div className="relative w-[34rem] max-w-[45vw] min-w-[12rem] h-6 flex items-center">
        {/* Plain progress rail (replaces the audio waveform). The wavesurfer
            surface below still owns click/drag-to-seek but renders transparent,
            so only this rail + the played fill + the knob show. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-border"
        />
        {audio.duration > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full bg-brand/60"
            style={{ width: `${(audio.currentTime / audio.duration) * 100}%` }}
          />
        )}
        <div
          ref={audio.containerRef}
          className="w-full"
          title="Click to seek · drag to scrub"
        />
        {audio.duration > 0 && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-brand ring-2 ring-surface shadow"
            style={{ left: `${(audio.currentTime / audio.duration) * 100}%` }}
          />
        )}
      </div>
      <span className="font-mono text-xs text-ink-muted w-10 tabular-nums shrink-0">
        {formatTime(audio.duration)}
      </span>
      </div>

      {/* Speed + trailing slot (right cell) */}
      <div className="flex items-center gap-3 justify-self-end">
        {showSpeed && (
          <label className="flex items-center gap-1.5">
            <span className="text-[11px] text-ink-muted">Speed</span>
            <select
              defaultValue="1"
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (onSpeedChange) onSpeedChange(v)
                else audio.setRate(v)
              }}
              className="text-xs border border-border rounded px-2 py-1 bg-surface text-ink hover:border-border-strong focus:outline-none focus:ring-1 focus:ring-border-strong"
            >
              <option value="0.5">0.5×</option>
              <option value="0.75">0.75×</option>
              <option value="1">1×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
          </label>
        )}
        {trailing}
      </div>
    </div>
  )
}
