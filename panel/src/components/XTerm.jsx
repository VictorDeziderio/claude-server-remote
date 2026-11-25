import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { termWsUrl } from '../api.js'
import { copyText, readClipboard, decodeOsc52 } from '../lib/clipboard.js'
import { touchScroll } from '../lib/termkeys.js'
import { t } from '../lib/i18n.js'

// REAL terminal: xterm.js <-> WebSocket (/ws/term) <-> PTY (node-pty) <-> `tmux attach`.
// Just like SSH: colors, cursor, Claude's TUI, automatic resize, mouse, paste, search.
// Reconnects by itself if the connection drops; closing the tab does NOT kill the tmux session.
//
// PuTTY-style copy/paste:
//  - SELECTED = COPIED: dragging selects in tmux, which on release sends the text over OSC 52
//    (handled here); Shift+drag uses xterm's own selection — it also copies on release.
//  - Ctrl+C: with a selection -> copies; without a selection -> ^C (interrupt) in the terminal.
//  - Ctrl+V / Cmd+V / Ctrl+Shift+V / right button / middle button -> pastes.
//
// Touch (phone):
//  - dragging 1 finger vertically = scrolls the tmux history (becomes a "mouse wheel" for tmux,
//    which has mouse on; without this xterm scrolls nothing: the tmux screen has no scrollback)
//  - holding the finger (~0.5s) = onLongPress (the page opens "Select text": native selection)
//  - 2-finger pinch = onPinch(scale) (the page changes the font)
//  - the "right button" Android generates on a long press does NOT paste (only a real mouse pastes)
//
// Connection: reconnects by itself with a growing wait; when coming back to the tab, when the network comes back and
// when the "ping" gets no answer (the phone slept and the socket died silently) it reconnects AT
// ONCE. onStatus(status, msg, { retryIn, attempt }).

// pure black (not the #0A0A0B of the rest of the app): the terminal area is visually
// distinct from the panel "chrome" around it -- it is the screen, not the interface.
const THEME = {
  background: '#000000', foreground: '#E8E6E1', cursor: '#F0A83C', cursorAccent: '#000000',
  selectionBackground: 'rgba(240,168,60,0.28)', selectionInactiveBackground: 'rgba(240,168,60,0.18)',
  black: '#1c1c1e', red: '#f87171', green: '#5fbf77', yellow: '#f0a83c', blue: '#60a5fa',
  magenta: '#c084fc', cyan: '#22d3ee', white: '#e8e6e1',
  brightBlack: '#8a8a85', brightRed: '#fca5a5', brightGreen: '#8cd99e', brightYellow: '#f7c878',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
}
const FONT = '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace'
const CTRL = '\x01'
const gray = (s) => `\r\n\x1b[90m${s}\x1b[0m\r\n`
const red = (s) => `\r\n\x1b[31m${s}\x1b[0m\r\n`
const SEARCH_DECOR = { matchBackground: '#3b2a1f', matchBorder: '#D97757', matchOverviewRuler: '#D97757', activeMatchBackground: '#D97757', activeMatchColorOverviewRuler: '#ffffff' }
const PING_EVERY = 20000 // ms between client pings
const DEAD_AFTER = 45000 // NOTHING from the server for this long = dead connection -> reconnect
const LONG_PRESS = 550
// phone/tablet: the finger is the main pointer
const isTouch = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches

// status: connecting | open | closed | error
const XTerm = forwardRef(function XTerm({ target, fontSize = 13, detach = false, onStatus, onSearchToggle, onCopy, onLongPress, onPinch, transformInput, className = '' }, ref) {
  const boxRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const searchRef = useRef(null)
  const wsRef = useRef(null)
  const stateRef = useRef({ retries: 0, timer: null, stopped: false, lastRx: 0 })
  const [status, setStatus] = useState('connecting')
  // callbacks in refs: the terminal is created 1x per target, but the handlers change on each render
  const cb = useRef({})
  cb.current = { onSearchToggle, onCopy, onLongPress, onPinch, transformInput, onStatus }
  const copy = useCallback(async (text) => {
    if (!text) return
    const ok = await copyText(text)
    cb.current.onCopy?.(ok, text)
  }, [])

  const emit = useCallback((s, msg, extra) => { setStatus(s); cb.current.onStatus?.(s, msg, extra || {}) }, [])
  const sendRaw = useCallback((data) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
  }, [])
  const fitNow = useCallback(() => { try { fitRef.current?.fit() } catch { /* container has no size yet */ } }, [])

  const connect = useCallback(() => {
    const term = termRef.current
    const st = stateRef.current
    if (!term || st.stopped) return
    clearTimeout(st.timer)
    if (wsRef.current) { const old = wsRef.current; wsRef.current = null; try { old.close() } catch { /* */ } }
    fitNow()
    const ws = new WebSocket(termWsUrl(target, term.cols, term.rows, detach))
    wsRef.current = ws
    emit('connecting', '', { attempt: st.retries })
    ws.onopen = () => {
      st.retries = 0; st.lastRx = Date.now()
      // the size may have changed WHILE connecting (font loaded, keyboard opened, rotation):
      // the resize of that interval was dropped (socket not open yet) -> send the current one
      ws.send(CTRL + JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      emit('open')
      // on the phone, focusing opens the keyboard by itself on each reconnect: only focus with a mouse
      if (!isTouch()) term.focus()
    }
    ws.onmessage = (ev) => {
      st.lastRx = Date.now()
      const d = typeof ev.data === 'string' ? ev.data : ''
      if (d.charCodeAt(0) === 1 && d.charCodeAt(1) === 123) {
        try {
          const c = JSON.parse(d.slice(1))
          if (c.type === 'exit') term.write(gray(t('term.ended')))
        } catch { /* ignora */ }
        return
      }
      term.write(d)
    }
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return // closed by us (target change / unmount)
      wsRef.current = null
      if (st.stopped) return
      if (ev.code >= 4000) { // logical server error: no point insisting
        emit('error', ev.reason || t('term.error'))
        term.write(red(`[${ev.reason || t('term.serverError')}]`))
        return
      }
      const delay = Math.min(15000, 800 * 2 ** st.retries++)
      emit('closed', ev.reason, { retryIn: delay, attempt: st.retries })
      term.write(gray(t('term.reconnecting', { s: Math.max(1, Math.round(delay / 1000)) })))
      st.timer = setTimeout(connect, delay)
    }
    ws.onerror = () => { /* onclose cuida */ }
  }, [target, detach, emit, fitNow])

  // reconnect NOW ("reconnect" button, tab came back, network came back, ping without answer)
  const reconnectNow = useCallback(() => {
    const st = stateRef.current
    if (st.stopped) return
    st.retries = 0
    connect()
  }, [connect])

  useImperativeHandle(ref, () => ({
    send: sendRaw,
    focus: () => termRef.current?.focus(),
    blur: () => termRef.current?.blur(),
    fit: fitNow,
    reconnect: reconnectNow,
    clear: () => termRef.current?.clear(),
    // pastes TEXT (with bracketed paste, like Ctrl+V)
    pasteText: (t) => { if (t) termRef.current?.paste(t); termRef.current?.focus() },
    // reads the clipboard and pastes; returns false if the browser did not allow reading it
    paste: async () => {
      const t = await readClipboard()
      if (t) termRef.current?.paste(t)
      termRef.current?.focus()
      return !!t
    },
    getSelection: () => termRef.current?.getSelection() || '',
    copySelection: () => copy(termRef.current?.getSelection() || ''),
    findNext: (q) => !!q && !!searchRef.current?.findNext(q, { decorations: SEARCH_DECOR, incremental: false }),
    findPrevious: (q) => !!q && !!searchRef.current?.findPrevious(q, { decorations: SEARCH_DECOR }),
    clearSearch: () => searchRef.current?.clearDecorations(),
    scrollToBottom: () => termRef.current?.scrollToBottom(),
    term: () => termRef.current,
  }), [sendRaw, reconnectNow, copy, fitNow])

  // creates the xterm + connects; recreates it on a target / detach mode change
  useEffect(() => {
    const st = stateRef.current
    st.stopped = false; st.retries = 0
    const touch = isTouch()
    const term = new Terminal({
      fontSize, fontFamily: FONT, theme: THEME, cursorBlink: true, cursorStyle: 'bar',
      scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true, allowTransparency: false,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')))
    // Unicode 11 widths (the ones of tmux/glibc). With the default table (Unicode 6) xterm and tmux
    // disagree on the width of symbols (✻ ❯ ⏺ emojis...) -> the cursor misaligns and
    // "little squares"/leftovers of Claude's animation stay on screen.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(boxRef.current)
    termRef.current = term; fitRef.current = fit; searchRef.current = search
    // WebGL renderer: MUCH faster than the DOM (Claude's TUI redraws the whole screen).
    // If the WebGL context does not exist/is lost, falls back to the default renderer by itself.
    // On the phone it stays on the DOM renderer: WebGL draws the wrong glyphs (huge/blurry)
    // with devicePixelRatio 3 on several devices, and on a ~45-column screen the DOM is already fast.
    if (!touch) {
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => { try { gl.dispose() } catch { /* */ } })
        term.loadAddon(gl)
      } catch { /* no WebGL: stays on the DOM */ }
    }
    // The font (JetBrains Mono) loads LATER: xterm measured the cell with the fallback font (narrower)
    // -> too many columns and the text went past the edge (on the phone it was cut on the right).
    // When the font arrives, swap the fontFamily (forces a new measure) and refit.
    if (document.fonts?.load) {
      Promise.all([document.fonts.load(`${fontSize}px "JetBrains Mono"`), document.fonts.load(`bold ${fontSize}px "JetBrains Mono"`)])
        .catch(() => {})
        .then(() => {
          if (termRef.current !== term) return
          term.options.fontFamily = FONT.replace('"JetBrains Mono"', "'JetBrains Mono'")
          try { fit.fit() } catch { /* */ }
        })
    }

    // OSC 52: tmux (set-clipboard on) sends here the text selected with the mouse -> copy.
    // WRITE only: clipboard read requests ("?") are ignored (a program on the server
    // must not read your clipboard).
    term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data)
      if (text) copy(text)
      return true
    })

    const pasteFromClipboard = () => readClipboard().then((t) => { if (t) term.paste(t); term.focus() })
    const copySelection = () => { const s = term.getSelection(); if (s) copy(s); return !!s }

    // Right button = paste (or copy, if there is a selection) — like PuTTY; middle button = paste
    const box = boxRef.current
    let lastTouch = 0
    const onCtx = (e) => {
      e.preventDefault()
      // a long press on Android fires "contextmenu": does NOT paste anything (the long press opens the selection)
      if (Date.now() - lastTouch < 1500) return
      if (copySelection()) { term.clearSelection(); return }
      pasteFromClipboard()
    }
    const onAux = (e) => { if (e.button === 1) { e.preventDefault(); pasteFromClipboard() } }
    // xterm's OWN selection (Shift+drag, or no mouse in tmux): copies on button release
    const onMouseUp = (e) => { if (e.button === 0 && term.hasSelection()) copySelection() }
    box.addEventListener('contextmenu', onCtx)
    box.addEventListener('auxclick', onAux)
    box.addEventListener('mouseup', onMouseUp)

    // ---- toque: rolar o historico do tmux, toque longo, pinca ----
    const g = { mode: null, x: 0, y: 0, y0: 0, carry: 0, timer: null, d0: 0 }
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const cellH = () => {
      const s = box.querySelector('.xterm-screen')
      return s && term.rows ? s.clientHeight / term.rows : 16
    }
    const mouseOn = () => term.modes.mouseTrackingMode !== 'none'
    // 1 wheel event = tmux scrolls ~5 lines; 1 event every 2 finger lines feels natural
    const wheel = (lines, x, y) => {
      const el = term.element
      if (!el) return
      for (let i = 0; i < Math.abs(lines); i++) {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: lines > 0 ? -1 : 1, deltaMode: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }))
      }
    }
    const endGesture = () => {
      clearTimeout(g.timer)
      if (g.mode === 'pinch') cb.current.onPinch?.(1, 'end')
      g.mode = null
    }
    const onTouchStart = (e) => {
      lastTouch = Date.now()
      clearTimeout(g.timer)
      if (e.touches.length === 2) {
        g.mode = 'pinch'; g.d0 = dist(e.touches) || 1
        cb.current.onPinch?.(1, 'start')
        return
      }
      if (e.touches.length !== 1) { g.mode = null; return }
      const t = e.touches[0]
      g.mode = 'pending'; g.x = t.clientX; g.y = t.clientY; g.y0 = t.clientY; g.carry = 0
      g.timer = setTimeout(() => {
        if (g.mode !== 'pending') return
        g.mode = 'long'
        cb.current.onLongPress?.()
      }, LONG_PRESS)
    }
    const onTouchMove = (e) => {
      lastTouch = Date.now()
      if (g.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault()
        cb.current.onPinch?.(dist(e.touches) / g.d0, 'move')
        return
      }
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      if (g.mode === 'pending' && Math.abs(t.clientY - g.y0) > 8) { clearTimeout(g.timer); g.mode = 'scroll' }
      if (g.mode !== 'scroll') return
      // with no mouse in the program (e.g. a screen without tmux) xterm itself scrolls the scrollback
      if (!mouseOn()) return
      e.preventDefault()
      const r = touchScroll(t.clientY - g.y, cellH() * 2, g.carry)
      g.carry = r.carry; g.y = t.clientY
      if (r.lines) wheel(r.lines, t.clientX, t.clientY)
    }
    box.addEventListener('touchstart', onTouchStart, { passive: true })
    box.addEventListener('touchmove', onTouchMove, { passive: false })
    box.addEventListener('touchend', endGesture, { passive: true })
    box.addEventListener('touchcancel', endGesture, { passive: true })

    term.onData((d) => {
      const tf = cb.current.transformInput
      sendRaw(tf ? tf(d) : d)
    })
    term.onResize(({ cols, rows }) => sendRaw(CTRL + JSON.stringify({ type: 'resize', cols, rows })))
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // e.key (not e.code): works on any layout (AZERTY, ABNT...) and on virtual
      // keyboards/IMEs that do not send keyCode
      const key = (e.key || '').toLowerCase()
      // Ctrl+Shift+F = busca
      if (e.ctrlKey && e.shiftKey && key === 'f') { cb.current.onSearchToggle?.(); return false }
      // Ctrl+Shift+C / Cmd+C = copy; Ctrl+C with a selection = copy; Ctrl+C without a selection = ^C in the terminal
      // (preventDefault: the browser's native "copy" event must not overwrite what we copied)
      if (key === 'c' && ((e.ctrlKey && e.shiftKey) || (isMac && e.metaKey))) { e.preventDefault(); copySelection(); return false }
      if (key === 'c' && e.ctrlKey && !e.altKey && term.hasSelection()) { e.preventDefault(); copySelection(); term.clearSelection(); return false }
      // Ctrl+V / Cmd+V / Ctrl+Shift+V = paste: lets the browser fire the "paste" event
      // (xterm pastes with bracketed paste) instead of sending ^V to the terminal
      if (key === 'v' && (e.ctrlKey || e.metaKey) && !e.altKey) return false
      // Ctrl+<letter> (^C, ^D, ^Z, ^A, ^R...) sent HERE, by e.key: xterm depends on keyCode,
      // which is missing on virtual keyboards/IMEs/synthetic events -> ^C "did not work"
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[a-z]$/.test(key)) {
        e.preventDefault()
        term.clearSelection()
        term.scrollToBottom()
        sendRaw(String.fromCharCode(key.charCodeAt(0) - 96))
        return false
      }
      return true
    })

    fitNow()
    // refit: the container changed (rotation, phone keyboard opened/closed, key bar...)
    let raf = 0
    const refit = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { try { fit.fit() } catch { /* */ } }) }
    const ro = new ResizeObserver(refit)
    ro.observe(boxRef.current)
    const vv = window.visualViewport
    vv?.addEventListener('resize', refit)
    window.addEventListener('orientationchange', refit)

    // connection: back to the tab / network back -> reconnect at once (or test with a ping)
    const probe = () => {
      if (st.stopped) return
      const ws = wsRef.current
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) { st.retries = 0; connect(); return }
      if (ws.readyState === WebSocket.OPEN) {
        const sentAt = Date.now()
        ws.send(CTRL + JSON.stringify({ type: 'ping' }))
        // the phone woke up with the socket "open" but dead: no answer in 4s -> reconnect
        setTimeout(() => { if (wsRef.current === ws && st.lastRx < sentAt) { st.retries = 0; connect() } }, 4000)
      }
    }
    const onVis = () => { if (document.visibilityState === 'visible') probe() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', probe)
    const hb = setInterval(() => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN || document.visibilityState !== 'visible') return
      if (Date.now() - st.lastRx > DEAD_AFTER) { st.retries = 0; connect(); return }
      ws.send(CTRL + JSON.stringify({ type: 'ping' }))
    }, PING_EVERY)
    connect()

    return () => {
      st.stopped = true
      clearTimeout(st.timer)
      clearTimeout(g.timer)
      clearInterval(hb)
      cancelAnimationFrame(raf)
      ro.disconnect()
      vv?.removeEventListener('resize', refit)
      window.removeEventListener('orientationchange', refit)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', probe)
      box.removeEventListener('contextmenu', onCtx)
      box.removeEventListener('auxclick', onAux)
      box.removeEventListener('mouseup', onMouseUp)
      box.removeEventListener('touchstart', onTouchStart)
      box.removeEventListener('touchmove', onTouchMove)
      box.removeEventListener('touchend', endGesture)
      box.removeEventListener('touchcancel', endGesture)
      if (wsRef.current) { const old = wsRef.current; wsRef.current = null; try { old.close() } catch { /* */ } }
      term.dispose()
      termRef.current = null; fitRef.current = null; searchRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, detach])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    fitNow()
  }, [fontSize, fitNow])

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`} data-status={status}>
      <div ref={boxRef} className="xterm-box h-full w-full" />
    </div>
  )
})

export default XTerm
