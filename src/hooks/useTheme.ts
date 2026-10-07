import { useSyncExternalStore } from 'react'

// Light/dark theme, backed by a `.dark` class on <html> (Tailwind darkMode:
// 'class') + a localStorage preference. A tiny module-level store so every
// consumer shares one source of truth, avoiding per-component state drift.

export type Theme = 'light' | 'dark'

const KEY = 'mlmi.theme'
const listeners = new Set<() => void>()

function readInitial(): Theme {
  try {
    const s = localStorage.getItem(KEY)
    if (s === 'dark' || s === 'light') return s
  } catch {
    /* localStorage unavailable — fall through */
  }
  // main.tsx sets the class pre-render from the same key; mirror it.
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

let theme: Theme = readInitial()

function apply(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark')
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* non-fatal: theme just won't persist */
  }
}

export function setTheme(next: Theme) {
  if (next === theme) return
  theme = next
  apply(theme)
  listeners.forEach((l) => l())
}

export function toggleTheme() {
  setTheme(theme === 'dark' ? 'light' : 'dark')
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useTheme() {
  const current = useSyncExternalStore(
    subscribe,
    () => theme,
    () => theme,
  )
  return { theme: current, setTheme, toggleTheme }
}
