import { useState } from 'react'
import ReviewWorkspace from './core/ReviewWorkspace'
import {
  CLEAN_BOTH_CONFIG,
  CLEAN_SENTENCE_CONFIG,
  CLEAN_WORD_CONFIG,
  COMPLETE_CONFIG,
  TOOLKIT_CONFIG,
  type WorkspaceConfig,
} from './core/config'
import { ASR_ENABLED } from './lib/apiBase'

// The version launcher (default build): ONE deployment, a landing menu, and
// every interface variant one click away.
// Adding a future variant = one entry here (+ its WorkspaceConfig).
interface Version {
  id: string
  title: string
  blurb: string
  config: WorkspaceConfig
}

// Restructured 2026-07-07 along two clean axes, so each adjacent pair differs
// by ONE thing: in-text highlighting (word / sentence / both) × AI toolkit
// (none / all). 1 vs 2 vs 3 = "which granularity should marks live at?";
// 1 vs 4 = "does the toolkit help?"; 4 vs 5 = "is the sentence layer worth it?"
const VERSIONS: Version[] = [
  {
    id: 'word',
    title: 'Word highlighting',
    blurb:
      'Only word-level risk marks: words that are likely wrong and matter are flagged in the text. No side tools.',
    config: CLEAN_WORD_CONFIG,
  },
  {
    id: 'sentence',
    title: 'Sentence highlighting',
    blurb:
      'Only whole-sentence marks, tinted by how confident the speech-recognition was — sentences most likely to be mis-transcribed stand out. No word marks, no side tools.',
    config: CLEAN_SENTENCE_CONFIG,
  },
  {
    id: 'word-sentence',
    title: 'Word + sentence highlighting',
    blurb:
      'Both layers together: word-level risk marks inside the sentence-confidence tint. No side tools.',
    config: CLEAN_BOTH_CONFIG,
  },
  {
    id: 'toolkit',
    title: 'AI toolkit',
    blurb:
      'Word highlighting plus every AI tool: keyword Find, chapter Outline, Ask-AI assistant, contradiction alerts and a clickable event timeline.',
    config: TOOLKIT_CONFIG,
  },
  {
    id: 'complete',
    title: 'Complete',
    blurb:
      'Everything at once: word + sentence highlighting and the full AI toolkit.',
    config: COMPLETE_CONFIG,
  },
]

export default function AppVersions() {
  const [active, setActive] = useState<Version | null>(null)

  // ---------------- Landing menu ----------------
  if (!active) {
    return (
      <div className="h-full bg-surface-muted flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <h1 className="text-sm font-semibold text-ink uppercase tracking-[0.15em] mb-1">
            Transcript review
          </h1>
          <p className="text-[12px] text-ink-muted mb-4 leading-relaxed">
            Choose an interface version. All five review the same demo
            interview — you can switch versions at any time.
          </p>
          {/* Onboarding: police reviewers land here cold — point them at the
              guide first. Static page in public/guide.html, served at /guide.html
              in local development; a new tab keeps this menu intact. */}
          <a
            href="/guide.html"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 mb-5 rounded-lg border border-brand/30 bg-brand-bg px-4 py-3 hover:border-brand/60 hover:shadow transition-all group"
          >
            <span className="text-lg leading-none">📖</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-brand">
                New here? Read the guide first
              </span>
              <span className="block text-[11.5px] text-ink-muted leading-snug">
                A quick tour of the highlights, tools and exports — opens in a new tab.
              </span>
            </span>
            <span className="ml-auto text-ink-faint group-hover:text-brand transition-colors">
              ↗
            </span>
          </a>
          <div className="space-y-3">
            {VERSIONS.map((v) => (
              <button
                key={v.id}
                onClick={() => setActive(v)}
                className="w-full text-left bg-surface border border-border rounded-lg shadow-sm px-5 py-4 hover:border-brand/50 hover:shadow transition-all group"
              >
                <p className="text-[13px] font-semibold text-ink group-hover:text-brand transition-colors">
                  {v.title}
                </p>
                <p className="mt-1 text-[12px] text-ink-muted leading-snug">{v.blurb}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ---------------- Selected version ----------------
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 shrink-0 text-[11px] bg-surface-muted border-b border-border">
        <span className="text-ink-faint uppercase tracking-widest">Version</span>
        <span className="text-ink font-medium">{active.title}</span>
        <button
          onClick={() => setActive(null)}
          className="ml-auto px-2 py-0.5 rounded border border-border text-ink-muted bg-surface hover:border-border-strong hover:text-ink transition-colors"
        >
          ‹ Switch version
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {/* key remounts the workspace per version — each entry starts fresh. */}
        <ReviewWorkspace
          key={active.id}
          // Hosted demo (VITE_ASR_ENABLED=false) has no ASR backend, so hide
          // audio→transcript + recording; the frozen demo case and transcript-
          // JSON upload still work. Local dev keeps everything.
          config={
            ASR_ENABLED
              ? active.config
              : { ...active.config, allowAutoTranscribe: false, allowRecord: false }
          }
        />
      </div>
    </div>
  )
}
