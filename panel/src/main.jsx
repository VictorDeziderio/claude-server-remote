import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import { initPwaHooks } from './lib/push.js'
import { installViewport } from './lib/viewport.js'
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme.js'

// tema claro/escuro (a 1a aplicacao ja aconteceu no index.html, antes de pintar)
applyTheme(readTheme())
watchSystemTheme()

// celular: altura visivel real (teclado virtual) -> --app-h / data-kb no <html>
installViewport()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

// PWA: service worker minimo (permite "instalar" no celular; nao faz cache da API/terminal)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
// Notifications tab: tap on a push -> the worker asks this window to open the page (no reload);
// Android/desktop "Install app" prompt fires early, kept until the tab shows its button
initPwaHooks()
