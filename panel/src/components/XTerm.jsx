import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { termWsUrl } from '../api.js'

// Terminal REAL: xterm.js <-> WebSocket (/ws/term) <-> PTY (node-pty) <-> `tmux attach`.
// Igual a um SSH: cores, cursor, TUI do Claude, resize automatico, mouse, colar, busca.
// Reconecta sozinho se a conexao cair; fechar a aba NAO mata a sessao tmux.

const THEME = {
  background: '#0b0d12', foreground: '#e7e9ee', cursor: '#D97757', cursorAccent: '#0b0d12',
  selectionBackground: 'rgba(217,119,87,0.35)', selectionInactiveBackground: 'rgba(217,119,87,0.2)',
  black: '#171b24', red: '#f87171', green: '#34d399', yellow: '#fbbf24', blue: '#60a5fa',
  magenta: '#c084fc', cyan: '#22d3ee', white: '#e7e9ee',
  brightBlack: '#5b6478', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fde68a',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
}
const FONT = '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace'
const CTRL = '\x01'
const gray = (s) => `\r\n\x1b[90m${s}\x1b[0m\r\n`
const red = (s) => `\r\n\x1b[31m${s}\x1b[0m\r\n`
const SEARCH_DECOR = { matchBackground: '#3b2a1f', matchBorder: '#D97757', matchOverviewRuler: '#D97757', activeMatchBackground: '#D97757', activeMatchColorOverviewRuler: '#ffffff' }

// status: connecting | open | closed | error
const XTerm = forwardRef(function XTerm({ target, fontSize = 13, detach = false, onStatus, onSearchToggle, className = '' }, ref) {
  const boxRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const searchRef = useRef(null)
  const wsRef = useRef(null)
  const stateRef = useRef({ retries: 0, timer: null, stopped: false })
  const [status, setStatus] = useState('connecting')
  const onSearchToggleRef = useRef(onSearchToggle)
  useEffect(() => { onSearchToggleRef.current = onSearchToggle }, [onSearchToggle])

  const emit = useCallback((s, msg) => { setStatus(s); onStatus?.(s, msg) }, [onStatus])
  const sendRaw = useCallback((data) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
  }, [])

  const connect = useCallback(() => {
    const term = termRef.current
    const st = stateRef.current
    if (!term || st.stopped) return
    clearTimeout(st.timer)
    if (wsRef.current) { const old = wsRef.current; wsRef.current = null; try { old.close() } catch { /* */ } }
    try { fitRef.current?.fit() } catch { /* container ainda sem tamanho */ }
    const ws = new WebSocket(termWsUrl(target, term.cols, term.rows, detach))
    wsRef.current = ws
    emit('connecting')
    ws.onopen = () => { st.retries = 0; emit('open'); term.focus() }
    ws.onmessage = (ev) => {
      const d = typeof ev.data === 'string' ? ev.data : ''
      if (d.charCodeAt(0) === 1) {
        try {
          const c = JSON.parse(d.slice(1))
          if (c.type === 'exit') term.write(gray('[sessão encerrada — reconectando…]'))
        } catch { /* ignora */ }
        return
      }
      term.write(d)
    }
    ws.onclose = (ev) => {
      if (wsRef.current !== ws) return // fechado por nos (troca de alvo / unmount)
      wsRef.current = null
      if (st.stopped) return
      if (ev.code >= 4000) { // erro logico do servidor: nao adianta insistir
        emit('error', ev.reason || 'erro')
        term.write(red(`[${ev.reason || 'erro no servidor'}]`))
        return
      }
      const delay = Math.min(15000, 800 * 2 ** st.retries++)
      emit('closed', ev.reason)
      term.write(gray(`[conexão perdida — reconectando em ${Math.round(delay / 1000)}s]`))
      st.timer = setTimeout(connect, delay)
    }
    ws.onerror = () => { /* onclose cuida */ }
  }, [target, detach, emit])

  useImperativeHandle(ref, () => ({
    send: sendRaw,
    focus: () => termRef.current?.focus(),
    fit: () => { try { fitRef.current?.fit() } catch { /* */ } },
    reconnect: () => { stateRef.current.retries = 0; connect() },
    clear: () => termRef.current?.clear(),
    paste: async () => {
      try { const t = await navigator.clipboard.readText(); if (t) termRef.current?.paste(t) }
      catch { termRef.current?.focus() }
    },
    getSelection: () => termRef.current?.getSelection() || '',
    findNext: (q) => !!q && !!searchRef.current?.findNext(q, { decorations: SEARCH_DECOR, incremental: false }),
    findPrevious: (q) => !!q && !!searchRef.current?.findPrevious(q, { decorations: SEARCH_DECOR }),
    clearSearch: () => searchRef.current?.clearDecorations(),
    term: () => termRef.current,
  }), [sendRaw, connect])

  // cria o xterm + conecta; recria ao trocar de alvo / modo detach
  useEffect(() => {
    const st = stateRef.current
    st.stopped = false; st.retries = 0
    const term = new Terminal({
      fontSize, fontFamily: FONT, theme: THEME, cursorBlink: true, cursorStyle: 'bar',
      scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true, allowTransparency: false,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')))
    term.open(boxRef.current)
    termRef.current = term; fitRef.current = fit; searchRef.current = search
    // Renderizador WebGL: MUITO mais rapido que o DOM (a TUI do Claude redesenha a tela toda).
    // Se o contexto WebGL nao existir/cair, volta pro renderizador padrao sozinho.
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => { try { gl.dispose() } catch { /* */ } })
      term.loadAddon(gl)
    } catch { /* sem WebGL: fica no DOM */ }

    // Botao direito = colar (ou copiar, se houver selecao) — como PuTTY/terminal; botao do meio = colar
    const box = boxRef.current
    const onCtx = (e) => {
      e.preventDefault()
      const sel = term.getSelection()
      if (sel) { navigator.clipboard?.writeText(sel).catch(() => {}); term.clearSelection(); return }
      navigator.clipboard?.readText().then((t) => { if (t) term.paste(t) }).catch(() => {})
      term.focus()
    }
    const onAux = (e) => { if (e.button === 1) { e.preventDefault(); navigator.clipboard?.readText().then((t) => t && term.paste(t)).catch(() => {}) } }
    box.addEventListener('contextmenu', onCtx)
    box.addEventListener('auxclick', onAux)

    term.onData((d) => sendRaw(d))
    term.onResize(({ cols, rows }) => sendRaw(CTRL + JSON.stringify({ type: 'resize', cols, rows })))
    // Ctrl+Shift+C copia a selecao; Ctrl+Shift+V cola; Ctrl+Shift+F busca (Ctrl+C/V vao pro terminal, como num SSH)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const s = term.getSelection(); if (s) navigator.clipboard?.writeText(s).catch(() => {})
        return false
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        navigator.clipboard?.readText().then((t) => t && term.paste(t)).catch(() => {})
        return false
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyF') { onSearchToggleRef.current?.(); return false }
      return true
    })

    try { fit.fit() } catch { /* */ }
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* */ } })
    ro.observe(boxRef.current)
    connect()

    return () => {
      st.stopped = true
      clearTimeout(st.timer)
      ro.disconnect()
      box.removeEventListener('contextmenu', onCtx)
      box.removeEventListener('auxclick', onAux)
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
    try { fitRef.current?.fit() } catch { /* */ }
  }, [fontSize])

  return (
    <div className={`relative h-full w-full overflow-hidden bg-[#0b0d12] ${className}`} data-status={status}>
      <div ref={boxRef} className="h-full w-full" />
    </div>
  )
})

export default XTerm
