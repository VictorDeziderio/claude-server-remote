import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA do painel "Claude Remote". Build -> dist/ (servido pelo server.js em producao).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
