/** @type {import('tailwindcss').Config} */

// Colours are CSS variables (channel triplets like "51 73 138") defined in
// src/index.css for :root (light) and .dark (dark). The rgb(var(--x) /
// <alpha-value>) form keeps every opacity utility (e.g. bg-brand/40) working
// while letting a single `.dark` class on <html> flip the whole palette.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Echo design language: Open Sans throughout (police "Echo" tool font).
        sans: ['Open Sans', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        // Mono kept for tabular timestamps / counters only.
        mono: ['JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      // Motion is used ONLY by the Outline storyboard (SPEC §3 keeps the rest
      // of the tool static); everything is applied via motion-safe: variants.
      keyframes: {
        'card-in': {
          from: { opacity: '0', transform: 'translateY(14px) scale(0.98)' },
          to: { opacity: '1', transform: 'none' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        draw: {
          from: { strokeDashoffset: '1' },
          to: { strokeDashoffset: '0' },
        },
        'slide-in-r': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'none' },
        },
        'pulse-brand': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgb(var(--brand) / 0.25)' },
          '60%': { boxShadow: '0 0 0 8px rgb(var(--brand) / 0)' },
        },
        // TimelineStrip: the panel "pulls up" out of the player bar.
        'strip-up': {
          from: { opacity: '0', transform: 'translateY(18px) scaleY(0.9)' },
          to: { opacity: '1', transform: 'none' },
        },
        // The playhead connector "draws" upward from the bar into the panel.
        'stem-up': {
          from: { transform: 'scaleY(0)' },
          to: { transform: 'scaleY(1)' },
        },
        // Violet "ready to click" ring on the Transcribe button once audio loads.
        'pulse-focus': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgb(var(--focus) / 0.35)' },
          '60%': { boxShadow: '0 0 0 6px rgb(var(--focus) / 0)' },
        },
        // Reviewer-name reminder: the name field flashes red when a review
        // action is taken with no name set.
        'flash-red': {
          '0%, 100%': {
            borderColor: 'rgb(var(--risk-high) / 1)',
            backgroundColor: 'rgb(var(--risk-high) / 0.14)',
            boxShadow: '0 0 0 3px rgb(var(--risk-high) / 0.25)',
          },
          '50%': {
            borderColor: 'rgb(var(--risk-high) / 0.35)',
            backgroundColor: 'rgb(var(--risk-high) / 0)',
            boxShadow: '0 0 0 0 rgb(var(--risk-high) / 0)',
          },
        },
      },
      animation: {
        'card-in': 'card-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
        'fade-in': 'fade-in 0.3s ease-out both',
        draw: 'draw 0.5s ease-out both',
        'slide-in-r': 'slide-in-r 0.25s cubic-bezier(0.22, 1, 0.36, 1) both',
        'pulse-brand': 'pulse-brand 2.4s ease-out infinite',
        'strip-up': 'strip-up 0.4s cubic-bezier(0.22, 1, 0.36, 1) both',
        'stem-up': 'stem-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
        'pulse-focus': 'pulse-focus 2s ease-out infinite',
        'flash-red': 'flash-red 0.7s ease-in-out infinite',
      },
      colors: {
        // Cool, calm surfaces (was warm "forensic" gray).
        surface: {
          DEFAULT: v('surface'),
          muted: v('surface-muted'), // page background
          subtle: v('surface-subtle'), // subtle fills / hovers
        },
        border: {
          DEFAULT: v('border'),
          strong: v('border-strong'),
        },
        ink: {
          DEFAULT: v('ink'), // primary text (soft near-black in light)
          muted: v('ink-muted'),
          faint: v('ink-faint'),
        },
        // Echo brand: navy primary + light-blue active.
        brand: {
          DEFAULT: v('brand'),
          dark: v('brand-dark'),
          bg: v('brand-bg'), // very light navy tint
          active: v('brand-active'), // active/selected segment
        },
        // Echo secondary accent (orange) — used sparingly + as the change-bar.
        accent: {
          DEFAULT: v('accent'),
          dark: v('accent-dark'),
          bg: v('accent-bg'),
        },
        risk: {
          high: v('risk-high'),
          'high-bg': v('risk-high-bg'),
          med: v('risk-med'),
          'med-bg': v('risk-med-bg'),
        },
        // Case-focus (2b) overlay — violet, distinct from risk + brand.
        focus: {
          DEFAULT: v('focus'),
          bg: v('focus-bg'),
        },
        verified: {
          DEFAULT: v('verified'),
          bg: v('verified-bg'),
          bar: v('verified-bar'),
        },
        // Track-changes = the reviewer's own edits, cool BLUE family.
        change: {
          ins: v('change-ins'),
          'ins-bg': v('change-ins-bg'),
          del: v('change-del'),
          'del-bg': v('change-del-bg'),
          bar: v('change-bar'),
        },
        // Coral "AI-generated — check carefully" banner (Echo warning panel).
        warning: {
          DEFAULT: v('warning'),
          bg: v('warning-bg'),
          border: v('warning-border'),
        },
        speaker: {
          officer: v('speaker-officer'),
          witness: v('speaker-witness'),
        },
      },
    },
  },
  plugins: [],
}
