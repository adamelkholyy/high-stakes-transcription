/// <reference types="vite/client" />

interface ImportMetaEnv {
  // 'complete' opens every tool directly; undefined selects the launcher.
  readonly VITE_APP_MODE?: 'complete' | 'full' | 'sentence'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
