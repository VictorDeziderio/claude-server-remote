// Entry of the public chat page (chat.html, served for /c/<key>). Kept apart from the panel:
// no router, no panel layout, no terminal/editor code.
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './chat.css'
import { installViewport } from '../lib/viewport.js'

// light/dark follows the system (the first pass already ran in /chat-theme.js, before painting)
const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
const applyScheme = () => document.documentElement.classList.toggle('dark', !!mq?.matches)
applyScheme()
mq?.addEventListener?.('change', applyScheme)

// phone: real visible height above the virtual keyboard -> --app-h / --app-top / data-kb on <html>
installViewport()

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
