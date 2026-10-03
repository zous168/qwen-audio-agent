import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: realpathSync(fileURLToPath(new URL('.', import.meta.url))),
  base: './',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3101',
        ws: true,
      },
    },
  },
})
