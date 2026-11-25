import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// build identity embedded in the bundle: the app compares it with the one the server announces (state.
// panelVersion/buildTime) and, if they differ (tab opened before a deploy), asks to reload.
// BUILD_TIME is written by the Dockerfile BEFORE `npm run build` — the same file the server reads.
const readBuild = () => { try { return fs.readFileSync(new URL('./BUILD_TIME', import.meta.url), 'utf8').trim() } catch { return '' } }
const pkgVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// SPA of the "Claude Remote" panel. Build -> dist/ (served by server.js in production).
// In dev (`npm run dev`), API and WebSocket are forwarded to a local server.js on 7001.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  define: {
    __PANEL_VERSION__: JSON.stringify(pkgVersion),
    __PANEL_BUILD__: JSON.stringify(readBuild()),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // no manualChunks: a forced "xterm" chunk was preloaded on EVERY page (index.html
    // modulepreload). Without it xterm goes with the lazy TerminalPage and loads only there.
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7001',
      '/ws': { target: 'ws://127.0.0.1:7001', ws: true },
    },
  },
})
