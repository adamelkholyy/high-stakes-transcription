import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: process.env.GITHUB_PAGES === 'true' ? '/MLMI-final-Project/' : '/',
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/.venv*/**'],
    },
  },
})
