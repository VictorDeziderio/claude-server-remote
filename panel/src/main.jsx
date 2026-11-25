import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import { initPwaHooks } from './lib/push.js'
import { installViewport } from './lib/viewport.js'
import { applyTheme, readTheme, watchSystemTheme } from './lib/theme.js'

// light/dark theme (the first application already happened in index.html, before painting)
applyTheme(readTheme())
watchSystemTheme()

// phone: real visible height (virtual keyboard) -> --app-h / data-kb on <html>
installViewport()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

// PWA: minimal service worker (allows "installing" on the phone; does not cache the API/terminal)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
// Notifications tab: tap on a push -> the worker asks this window to open the page (no reload);
// Android/desktop "Install app" prompt fires early, kept until the tab shows its button
initPwaHooks()
