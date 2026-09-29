import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// identidade do build embutida no bundle: o app compara com a que o servidor anuncia (state.
// panelVersion/buildTime) e, se diferirem (aba aberta antes de um deploy), pede p/ recarregar.
// BUILD_TIME e gravado pelo Dockerfile ANTES do `npm run build` — o mesmo arquivo que o server le.
const readBuild = () => { try { return fs.readFileSync(new URL('./BUILD_TIME', import.meta.url), 'utf8').trim() } catch { return '' } }
const pkgVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// SPA do painel "Claude Remote". Build -> dist/ (servido pelo server.js em producao).
// Em dev (`npm run dev`), API e WebSocket sao encaminhados p/ um server.js local na 7001.
export default defineConfig({
  plugins: [react()],
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
    rollupOptions: {
      output: {
        manualChunks: { xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'] },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7001',
      '/ws': { target: 'ws://127.0.0.1:7001', ws: true },
    },
  },
})
