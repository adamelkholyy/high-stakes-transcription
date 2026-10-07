import React from 'react'
import ReactDOM from 'react-dom/client'
import AppComplete from './AppComplete'
import AppFull from './AppFull'
import AppSentence from './AppSentence'
import AppVersions from './AppVersions'
import './index.css'

// Apply the saved theme BEFORE first paint so dark mode never flashes light.
// Mirrors the key used by src/hooks/useTheme.ts.
try {
  if (localStorage.getItem('mlmi.theme') === 'dark') {
    document.documentElement.classList.add('dark')
  }
} catch {
  /* localStorage unavailable — default light */
}

// Build-time shell selection. `complete` is the direct handoff build with all
// tools enabled; omitting the value keeps the five-version research launcher.
const App =
  import.meta.env.VITE_APP_MODE === 'complete'
    ? AppComplete
    : import.meta.env.VITE_APP_MODE === 'sentence'
    ? AppSentence
    : import.meta.env.VITE_APP_MODE === 'full'
      ? AppFull
      : AppVersions

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
