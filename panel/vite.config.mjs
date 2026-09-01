import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA do painel "Claude Remote". Build -> dist/ (servido pelo server.js em producao).
// Em dev (`npm run dev`), API e WebSocket sao encaminhados p/ um server.js local na 7001.
export default defineConfig({
  plugins: [react()],
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
