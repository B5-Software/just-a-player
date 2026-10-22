import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
const dir = (path) => fileURLToPath(new URL(path, import.meta.url))
export default defineConfig({
  root: dir('../desktop/src/renderer'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': dir('../desktop/src/shared'),
      '@renderer': dir('../desktop/src/renderer/src'),
    },
  },
  build: {
    outDir: dir('./app/src/main/assets/web'),
    emptyOutDir: true,
    target: 'chrome100',
    chunkSizeWarningLimit: 1800,
  },
})
