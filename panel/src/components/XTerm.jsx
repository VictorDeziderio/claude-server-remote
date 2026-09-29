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

// Terminal REAL: xterm.js <-> WebSocket (/ws/term) <-> PTY (node-pty) <-> `tmux attach`.
// Igual a um SSH: cores, cursor, TUI do Claude, resize automatico, mouse, colar, busca.
// Reconecta sozinho se a conexao cair; fechar a aba NAO mata a sessao tmux.
//
// Copiar/colar estilo PuTTY:
//  - SELECIONOU, COPIOU: arrastar seleciona no tmux, que ao soltar manda o texto por OSC 52
//    (tratado aqui); Shift+arrastar usa a selecao do proprio xterm — copia ao soltar tambem.
//  - Ctrl+C: com selecao -> copia; sem selecao -> ^C (interrompe) no terminal.
//  - Ctrl+V / Cmd+V / Ctrl+Shift+V / botao direito / botao do meio -> cola.

const THEME = {
  background: '#080B11', foreground: '#ECF1F8', cursor: '#E37D45', cursorAccent: '#080B11',
  selectionBackground: 'rgba(227,125,69,0.28)', selectionInactiveBackground: 'rgba(227,125,69,0.18)',
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
const XTerm = forwardRef(function XTerm({ target, fontSize = 13, detach = false, onStatus, onSearchToggle, onCopy, className = '' }, ref) {
  const boxRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const searchRef = useRef(null)
  const wsRef = useRef(null)
  const stateRef = useRef({ retries: 0, timer: null, stopped: false })
  const [status, setStatus] = useState('connecting')
  const onSearchToggleRef = useRef(onSearchToggle)
  useEffect(() => { onSearchToggleRef.current = onSearchToggle }, [onSearchToggle])
  const onCopyRef = useRef(onCopy)
  useEffect(() => { onCopyRef.current = onCopy }, [onCopy])
  const copy = useCallback(async (text) => {
    if (!text) return
    const ok = await copyText(text)
    onCopyRef.current?.(ok, text)
  }, [])

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
          if (c.type === 'exit') term.write(gray('[sessão encerrada]'))
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
      const t = await readClipboard()
      if (t) termRef.current?.paste(t)
      termRef.current?.focus()
    },
    getSelection: () => termRef.current?.getSelection() || '',
    copySelection: () => copy(termRef.current?.getSelection() || ''),
    findNext: (q) => !!q && !!searchRef.current?.findNext(q, { decorations: SEARCH_DECOR, incremental: false }),
    findPrevious: (q) => !!q && !!searchRef.current?.findPrevious(q, { decorations: SEARCH_DECOR }),
    clearSearch: () => searchRef.current?.clearDecorations(),
    term: () => termRef.current,
  }), [sendRaw, connect, copy])

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
    // Larguras Unicode 11 (as do tmux/glibc). Com a tabela padrao (Unicode 6) xterm e tmux
    // discordam da largura de simbolos (✻ ❯ ⏺ emojis...) -> o cursor desalinha e sobram
    // "quadradinhos"/restos da animacao do Claude na tela.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(boxRef.current)
    termRef.current = term; fitRef.current = fit; searchRef.current = search
    // Renderizador WebGL: MUITO mais rapido que o DOM (a TUI do Claude redesenha a tela toda).
    // Se o contexto WebGL nao existir/cair, volta pro renderizador padrao sozinho.
    try {
      const gl = new WebglAddon()
      gl.onContextLoss(() => { try { gl.dispose() } catch { /* */ } })
      term.loadAddon(gl)
    } catch { /* sem WebGL: fica no DOM */ }

    // OSC 52: o tmux (set-clipboard on) manda aqui o texto selecionado com o mouse -> copia.
    // So ESCRITA: pedidos de leitura do clipboard ("?") sao ignorados (um programa no servidor
    // nao pode ler a sua area de transferencia).
    term.parser.registerOscHandler(52, (data) => {
      const text = decodeOsc52(data)
      if (text) copy(text)
      return true
    })

    const pasteFromClipboard = () => readClipboard().then((t) => { if (t) term.paste(t); term.focus() })
    const copySelection = () => { const s = term.getSelection(); if (s) copy(s); return !!s }

    // Botao direito = colar (ou copiar, se houver selecao) — como PuTTY; botao do meio = colar
    const box = boxRef.current
    const onCtx = (e) => {
      e.preventDefault()
      if (copySelection()) { term.clearSelection(); return }
      pasteFromClipboard()
    }
    const onAux = (e) => { if (e.button === 1) { e.preventDefault(); pasteFromClipboard() } }
    // selecao do PROPRIO xterm (Shift+arrastar, ou sem mouse no tmux): copia ao soltar o botao
    const onMouseUp = (e) => { if (e.button === 0 && term.hasSelection()) copySelection() }
    box.addEventListener('contextmenu', onCtx)
    box.addEventListener('auxclick', onAux)
    box.addEventListener('mouseup', onMouseUp)

    term.onData((d) => sendRaw(d))
    term.onResize(({ cols, rows }) => sendRaw(CTRL + JSON.stringify({ type: 'resize', cols, rows })))
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      // e.key (e nao e.code): funciona em qualquer layout (AZERTY, ABNT...) e em teclados
      // virtuais/IMEs que nao mandam keyCode
      const key = (e.key || '').toLowerCase()
      // Ctrl+Shift+F = busca
      if (e.ctrlKey && e.shiftKey && key === 'f') { onSearchToggleRef.current?.(); return false }
      // Ctrl+Shift+C / Cmd+C = copiar; Ctrl+C com selecao = copiar; Ctrl+C sem selecao = ^C no terminal
      // (preventDefault: o evento "copy" nativo do navegador nao pode sobrescrever o que copiamos)
      if (key === 'c' && ((e.ctrlKey && e.shiftKey) || (isMac && e.metaKey))) { e.preventDefault(); copySelection(); return false }
      if (key === 'c' && e.ctrlKey && !e.altKey && term.hasSelection()) { e.preventDefault(); copySelection(); term.clearSelection(); return false }
      // Ctrl+V / Cmd+V / Ctrl+Shift+V = colar: deixa o navegador disparar o evento "paste"
      // (o xterm cola com bracketed paste) em vez de mandar ^V pro terminal
      if (key === 'v' && (e.ctrlKey || e.metaKey) && !e.altKey) return false
      // Ctrl+<letra> (^C, ^D, ^Z, ^A, ^R...) enviado AQUI, pelo e.key: o xterm depende do keyCode,
      // que falta em teclados virtuais/IMEs/eventos sinteticos -> o ^C "nao funcionava"
      if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && /^[a-z]$/.test(key)) {
        e.preventDefault()
        term.clearSelection()
        term.scrollToBottom()
        sendRaw(String.fromCharCode(key.charCodeAt(0) - 96))
        return false
      }
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
      box.removeEventListener('mouseup', onMouseUp)
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
    <div className={`relative h-full w-full overflow-hidden bg-[#080B11] ${className}`} data-status={status}>
      <div ref={boxRef} className="h-full w-full" />
    </div>
  )
})

export default XTerm
