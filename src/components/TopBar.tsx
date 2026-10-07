import { useEffect, useRef, useState } from 'react'
import type { ModelName } from '../types'
import type { RiskRegime } from '../core/config'
import { Menu, MenuItem, MenuRow, MenuSection } from './Menu'

interface Props {
  model: ModelName
  availableModels: ModelName[]
  onModelChange: (model: ModelName) => void
  audioFilename: string | null
  transcriptFilename: string | null
  onUploadAudio: (file: File) => void
  onUploadTranscript: (file: File) => void
  recording: boolean
  recordingElapsedMs: number
  recordingSupported: boolean
  onToggleRecord: () => void
  recordingDownloadUrl: string | null
  recordingDownloadName: string | null
  // Reviewer identity — stamped on every audit-trail entry. Lives in the top
  // bar next to the file actions (moved up from the player bar).
  reviewer: string
  onReviewerChange: (name: string) => void
  // Bump to flash the reviewer field red for ~10s — fired when a review action
  // is taken with no name set (reminder to identify yourself).
  nameFlash?: number
  // Runtime flagging-regime toggle: preview quiet and dense policies.
  allowRiskRegime?: boolean
  riskRegime?: RiskRegime
  onRiskRegimeChange?: (r: RiskRegime) => void
  allowUpload?: boolean
  allowRecord?: boolean
  // "Transcribe" runs the ASR service on the currently-loaded audio. Decoupled
  // from the Audio button (which now only loads audio for playback).
  allowTranscribe?: boolean
  canTranscribe?: boolean
  transcribing?: boolean
  onTranscribe?: () => void
  // Estimated total transcription time (seconds) for the current audio, used to
  // animate the progress bar shown under the filename while transcribing.
  transcribeEstimateSec?: number
  /** Diarisation hint for the ASR service: exactly N speakers (e.g. 2 for an
   *  interview). null/empty = automatic. Rendered as a small "Speakers" box
   *  next to Transcribe when the handler is provided. */
  numSpeakers?: number | null
  onNumSpeakersChange?: (n: number | null) => void
  // Track-changes view toggle.
  allowChangeToggle?: boolean
  showChanges?: boolean
  onToggleChanges?: () => void
  // Light/dark theme toggle.
  allowThemeToggle?: boolean
  theme?: 'light' | 'dark'
  onToggleTheme?: () => void
  // Sentence build: the LLM is triaging which sentences matter (auto-run).
  triageRunning?: boolean
}

function UploadIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 7V1.5M5 1.5 2.5 4M5 1.5 7.5 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.5 8.5h7" strokeLinecap="round" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="3.5" y="1" width="3" height="5" rx="1.5" />
      <path d="M2 5.5a3 3 0 0 0 6 0" strokeLinecap="round" />
      <path d="M5 8.5V9.5" strokeLinecap="round" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor">
      <rect x="1" y="1" width="7" height="7" rx="0.5" />
    </svg>
  )
}


function DownloadIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 1.5V7M5 7 2.5 4.5M5 7 7.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M1.5 8.5h7" strokeLinecap="round" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  )
}

function TranscribeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 4v2M4 2.5v5M6 1.5v7M8 3.5v3" strokeLinecap="round" />
    </svg>
  )
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Shared style for the visible File toolbar buttons in the header.
const TOOL_BTN =
  'flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink px-2 py-1 rounded-md border border-border hover:border-border-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-ink-muted disabled:hover:border-border'

// Transcribe once audio is loaded: violet "you can run this now" emphasis with a
// gentle pulsing ring. Falls back to the plain tool style while disabled.
const TRANSCRIBE_READY =
  'flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border transition-colors text-focus border-focus/50 bg-focus-bg hover:border-focus motion-safe:animate-pulse-focus'

export default function TopBar({
  model,
  availableModels,
  onModelChange,
  audioFilename,
  transcriptFilename,
  onUploadAudio,
  onUploadTranscript,
  recording,
  recordingElapsedMs,
  recordingSupported,
  onToggleRecord,
  recordingDownloadUrl,
  recordingDownloadName,
  reviewer,
  onReviewerChange,
  nameFlash = 0,
  allowRiskRegime = false,
  riskRegime = 'deployment',
  onRiskRegimeChange,
  allowUpload = true,
  allowRecord = true,
  allowTranscribe = false,
  canTranscribe = false,
  transcribing = false,
  onTranscribe,
  transcribeEstimateSec = 60,
  numSpeakers = null,
  onNumSpeakersChange,
  allowChangeToggle = false,
  showChanges = true,
  onToggleChanges,
  allowThemeToggle,
  theme,
  onToggleTheme,
  triageRunning = false,
}: Props) {
  const audioInputRef = useRef<HTMLInputElement>(null)
  const transcriptInputRef = useRef<HTMLInputElement>(null)

  // Flash the reviewer field red for 10s when `nameFlash` bumps (a review
  // action was taken with no name set). Re-arming the timer on each bump keeps
  // it flashing while the reviewer keeps acting without a name.
  const [nameFlashing, setNameFlashing] = useState(false)
  useEffect(() => {
    if (!nameFlash) return
    setNameFlashing(true)
    const t = setTimeout(() => setNameFlashing(false), 10000)
    return () => clearTimeout(t)
  }, [nameFlash])
  // A filled-in name clears the reminder immediately.
  useEffect(() => {
    if (reviewer.trim() !== '') setNameFlashing(false)
  }, [reviewer])

  // Transcription progress — the ASR service is one long blocking request with
  // no real progress signal, so we ESTIMATE from the audio length: fill
  // linearly to 90% over `transcribeEstimateSec`, then crawl 90→99% so an
  // over-run never looks "done". It vanishes the moment `transcribing` clears.
  const [transcribePct, setTranscribePct] = useState(0)
  const [transcribeRemainSec, setTranscribeRemainSec] = useState(0)
  useEffect(() => {
    if (!transcribing) {
      setTranscribePct(0)
      return
    }
    const est = Math.max(10, transcribeEstimateSec)
    const start = Date.now()
    const tick = () => {
      const elapsed = (Date.now() - start) / 1000
      const p =
        elapsed < est
          ? 0.9 * (elapsed / est)
          : 0.9 + 0.09 * (1 - Math.exp(-(elapsed - est) / est))
      setTranscribePct(Math.min(0.99, p))
      setTranscribeRemainSec(Math.max(0, est - elapsed))
    }
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [transcribing, transcribeEstimateSec])

  const remainLabel =
    transcribeRemainSec <= 1
      ? 'finishing…'
      : transcribeRemainSec >= 90
        ? `~${Math.ceil(transcribeRemainSec / 60)} min left`
        : `~${Math.ceil(transcribeRemainSec / 10) * 10}s left`

  return (
    <header className="h-14 flex items-center px-5 gap-4 bg-surface border-b border-border shrink-0">
      {/* Filename block */}
      <div className="flex flex-col leading-tight mr-1 min-w-0 max-w-[14rem]">
        <span className="font-mono text-[11px] text-ink tracking-wide truncate" title={audioFilename ?? undefined}>
          {audioFilename ?? 'interview_2024-03-14_case447.wav'}
        </span>
        {transcribing ? (
          // Estimated transcription progress (replaces the subtitle while running).
          <span className="flex items-center gap-1.5 mt-0.5" title="Estimated from the audio length — the ASR service reports no real progress">
            <span className="relative h-1 flex-1 rounded-full bg-surface-muted overflow-hidden">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-brand transition-[width] duration-200 ease-linear"
                style={{ width: `${(transcribePct * 100).toFixed(1)}%` }}
              />
            </span>
            <span className="text-[10px] text-ink-faint tabular-nums shrink-0">{remainLabel}</span>
          </span>
        ) : (
          <span className="text-[10px] text-ink-faint italic truncate">
            {audioFilename
              ? `uploaded audio${transcriptFilename ? ` · ${transcriptFilename}` : ''}`
              : transcriptFilename
              ? `placeholder audio · ${transcriptFilename}`
              : ''}
          </span>
        )}
      </div>

      {/* Hidden file inputs — triggered from the visible Audio / Transcript buttons. */}
      {allowUpload && (
        <>
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac,.webm,.mp4"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onUploadAudio(f)
              e.target.value = ''
            }}
          />
          <input
            ref={transcriptInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onUploadTranscript(f)
              e.target.value = ''
            }}
          />
        </>
      )}

      {/* Visible File actions (full build only — every button is flag-gated). */}
      {(allowUpload || allowTranscribe || allowRecord) && (
        <div className="flex items-center gap-1">
          {allowUpload && (
            <button
              onClick={() => audioInputRef.current?.click()}
              title="Replace the placeholder audio with a real .wav / .mp3 file"
              className={TOOL_BTN}
            >
              <UploadIcon />
              Audio…
            </button>
          )}
          {allowUpload && (
            <button
              onClick={() => transcriptInputRef.current?.click()}
              title="Replace the mock transcript with a .json file"
              className={TOOL_BTN}
            >
              <UploadIcon />
              Transcript…
            </button>
          )}
          {allowTranscribe && (
            <button
              onClick={onTranscribe}
              disabled={!canTranscribe || transcribing}
              title={canTranscribe ? 'Run the ASR models on the loaded audio' : 'Load an audio file first'}
              className={canTranscribe && !transcribing ? TRANSCRIBE_READY : TOOL_BTN}
            >
              <TranscribeIcon />
              {transcribing ? 'Transcribing…' : 'Transcribe'}
            </button>
          )}
          {allowRecord && (
            <button
              onClick={onToggleRecord}
              disabled={!recordingSupported}
              title={
                recordingSupported
                  ? recording
                    ? 'Stop recording and load it as the current audio'
                    : 'Record audio from your microphone'
                  : 'Recording is not supported in this browser'
              }
              className={[TOOL_BTN, recording ? 'border-warning-border/60 text-warning' : ''].join(' ')}
            >
              {recording ? <StopIcon /> : <MicIcon />}
              {recording ? `Stop (${formatElapsed(recordingElapsedMs)})` : 'Record'}
            </button>
          )}
          {recordingDownloadUrl && recordingDownloadName && !recording && (
            <a
              href={recordingDownloadUrl}
              download={recordingDownloadName}
              title="Save the recorded audio to disk (for external transcription)"
              className={TOOL_BTN}
            >
              <DownloadIcon />
              Save
            </a>
          )}
        </div>
      )}

      {/* Reviewer identity — sits right after the file actions (moved up from
          the player bar). Always rendered so it survives builds that hide the
          file buttons. */}
      <label
        className="flex items-center gap-1.5 shrink-0"
        title="Recorded on every audit-trail entry"
        data-tour="reviewer"
      >
        <span className="text-[11px] text-ink-muted">Reviewer</span>
        <input
          type="text"
          value={reviewer}
          onChange={(e) => onReviewerChange(e.target.value)}
          placeholder="Set your name…"
          className={[
            'text-xs border rounded px-2 py-1 bg-surface text-ink w-32 focus:outline-none focus:ring-1 focus:ring-border-strong transition-colors',
            nameFlashing
              ? 'animate-flash-red border-risk-high text-risk-high placeholder:text-risk-high'
              : reviewer.trim() === ''
                ? 'border-risk-med/50 focus:ring-risk-med/40 placeholder:text-risk-med/70 placeholder:italic'
                : 'border-border hover:border-border-strong',
          ].join(' ')}
        />
      </label>

      {/* Spacer: pushes the config group to the right (playback moved to the
          bottom bar). */}
      <div className="flex-1" />

      <div className="flex items-center gap-3">
        {/* Sentence build: the local LLM is picking the important sentences. */}
        {triageRunning && (
          <span
            className="flex items-center gap-1.5 text-[11px] text-ink-muted"
            aria-live="polite"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              className="animate-spin"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="5" cy="5" r="3.5" strokeOpacity="0.25" />
              <path d="M5 1.5a3.5 3.5 0 0 1 3.5 3.5" strokeLinecap="round" />
            </svg>
            ranking sentences…
          </span>
        )}

        {/* Model / Risk / scoring live in this menu. The
            View (Model / Risk) + Display live in it. */}
        <Menu
          align="right"
          title="Settings"
          triggerClassName="flex items-center gap-1.5 text-ink-muted hover:text-ink px-1.5 py-1 rounded-md border border-border hover:border-border-strong transition-colors"
          trigger={() => <MoreIcon />}
        >
          {() => (
            <>
              <MenuSection label="View">
                <MenuRow label="Model">
                  <select
                    value={model}
                    onChange={(e) => onModelChange(e.target.value as ModelName)}
                    className="text-[11px] border border-border rounded-md px-1.5 py-0.5 bg-surface text-ink hover:border-border-strong focus:outline-none focus:ring-1 focus:ring-border-strong max-w-[9rem]"
                  >
                    {availableModels.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </MenuRow>
                {allowTranscribe && onNumSpeakersChange && (
                  <MenuRow label="Speakers">
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={numSpeakers ?? ''}
                      disabled={transcribing}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10)
                        onNumSpeakersChange(Number.isFinite(v) && v > 0 ? v : null)
                      }}
                      placeholder="auto"
                      title="How many speakers are in the audio (diarisation hint — e.g. 2 for an interview). Leave empty for automatic detection."
                      className="w-16 text-[11px] border border-border rounded-md px-1.5 py-0.5 bg-surface text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-border-strong disabled:opacity-50"
                    />
                  </MenuRow>
                )}
              </MenuSection>

              {(allowRiskRegime || allowChangeToggle || allowThemeToggle) && (
                <MenuSection label="Display">
                  {allowRiskRegime && (
                      <MenuItem
                        active={riskRegime === 'dense'}
                        title="Flagging regime for the Combined view — Deployment: quiet · Dense: pass-through"
                        onClick={() => onRiskRegimeChange?.(riskRegime === 'deployment' ? 'dense' : 'deployment')}
                      >
                        Flagging: {riskRegime === 'dense' ? 'Dense' : 'Deployment'}
                      </MenuItem>
                    )}
                    {allowChangeToggle && (
                      <MenuItem
                        active={showChanges}
                        title={showChanges ? 'Hide reviewer changes (clean read)' : 'Show reviewer changes'}
                        onClick={() => onToggleChanges?.()}
                      >
                        Changes: {showChanges ? 'on' : 'off'}
                      </MenuItem>
                    )}
                    {allowThemeToggle && (
                      <MenuItem
                        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                        onClick={() => onToggleTheme?.()}
                      >
                        {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                      </MenuItem>
                    )}
                </MenuSection>
              )}

              {/* Always-available help — a persistent entry point to the reviewer
                  guide, in addition to the per-editor Help links. */}
              <MenuSection label="Help">
                <MenuItem
                  title="Open the reviewer guide in a new tab"
                  onClick={() => window.open('/guide.html', '_blank', 'noopener,noreferrer')}
                >
                  Reviewer guide ↗
                </MenuItem>
              </MenuSection>
            </>
          )}
        </Menu>
      </div>
    </header>
  )
}
