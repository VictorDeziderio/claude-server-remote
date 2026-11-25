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

// Terminal REAL: xterm.js <-> WebSocket (/ws/term) <-> PTY (node-pty) <-> `tmux attach`.
// Igual a um SSH: cores, cursor, TUI do Claude, resize automatico, mouse, colar, busca.
// Reconecta sozinho se a conexao cair; fechar a aba NAO mata a sessao tmux.
//
// Copiar/colar estilo PuTTY:
//  - SELECIONOU, COPIOU: arrastar seleciona no tmux, que ao soltar manda o texto por OSC 52
//    (tratado aqui); Shift+arrastar usa a selecao do proprio xterm — copia ao soltar tambem.
//  - Ctrl+C: com selecao -> copia; sem selecao -> ^C (interrompe) no terminal.
//  - Ctrl+V / Cmd+V / Ctrl+Shift+V / botao direito / botao do meio -> cola.
//
// Toque (celular):
//  - arrastar 1 dedo na vertical = rola o historico do tmux (vira "roda do mouse" p/ o tmux,
//    que esta com mouse on; sem isso o xterm nao rola nada: a tela do tmux nao tem scrollback)
//  - segurar o dedo (~0,5s) = onLongPress (a pagina abre "Selecionar texto": selecao nativa)
//  - pinca com 2 dedos = onPinch(escala) (a pagina muda a fonte)
//  - o "botao direito" que o Android gera no toque longo NAO cola (so o mouse de verdade cola)
//
// Conexao: reconecta sozinho com espera crescente; ao voltar p/ a aba, ao voltar a rede e
// quando o "ping" fica sem resposta (celular dormiu e o socket morreu sem avisar) reconecta NA
// HORA. onStatus(status, msg, { retryIn, attempt }).

// preto puro (nao o #0A0A0B do resto do app): a area do terminal fica visualmente
// distinta do "chrome" do painel ao redor -- e' a tela, nao a interface.
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
const PING_EVERY = 20000 // ms entre pings do cliente
const DEAD_AFTER = 45000 // sem NADA do servidor ha esse tempo = conexao morta -> reconecta
const LONG_PRESS = 550
// celular/tablet: dedo e o ponteiro principal
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
  // callbacks em refs: o terminal e criado 1x por alvo, mas os handlers mudam a cada render
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
  const fitNow = useCallback(() => { try { fitRef.current?.fit() } catch { /* container ainda sem tamanho */ } }, [])

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
      // o tamanho pode ter mudado ENQUANTO conectava (fonte carregou, teclado abriu, rotacao):
      // o resize desse intervalo foi descartado (socket ainda nao aberto) -> manda o atual
      ws.send(CTRL + JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      emit('open')
      // no celular, focar abre o teclado sozinho a cada reconexao: so foca com mouse
      if (!isTouch()) term.focus()
    }
    ws.onmessage = (ev) => {
      st.lastRx = Date.now()
      const d = typeof ev.data === 'string' ? ev.data : ''
      if (d.charCodeAt(0) === 1 && d.charCodeAt(1) === 123) {
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
      emit('closed', ev.reason, { retryIn: delay, attempt: st.retries })
      term.write(gray(`[conexão perdida — reconectando em ${Math.max(1, Math.round(delay / 1000))}s]`))
      st.timer = setTimeout(connect, delay)
    }
    ws.onerror = () => { /* onclose cuida */ }
  }, [target, detach, emit, fitNow])

  // reconecta JA (botao "reconectar", aba voltou, rede voltou, ping sem resposta)
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
    // cola TEXTO (com bracketed paste, como o Ctrl+V)
    pasteText: (t) => { if (t) termRef.current?.paste(t); termRef.current?.focus() },
    // le a area de transferencia e cola; devolve false se o navegador nao deixou ler
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

  // cria o xterm + conecta; recria ao trocar de alvo / modo detach
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
    // Larguras Unicode 11 (as do tmux/glibc). Com a tabela padrao (Unicode 6) xterm e tmux
    // discordam da largura de simbolos (✻ ❯ ⏺ emojis...) -> o cursor desalinha e sobram
    // "quadradinhos"/restos da animacao do Claude na tela.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(boxRef.current)
    termRef.current = term; fitRef.current = fit; searchRef.current = search
    // Renderizador WebGL: MUITO mais rapido que o DOM (a TUI do Claude redesenha a tela toda).
    // Se o contexto WebGL nao existir/cair, volta pro renderizador padrao sozinho.
    // No celular fica o renderizador DOM: o WebGL desenha os glifos errados (gigantes/borrados)
    // com devicePixelRatio 3 em varios aparelhos, e numa tela de ~45 colunas o DOM ja e rapido.
    if (!touch) {
      try {
        const gl = new WebglAddon()
        gl.onContextLoss(() => { try { gl.dispose() } catch { /* */ } })
        term.loadAddon(gl)
      } catch { /* sem WebGL: fica no DOM */ }
    }
    // A fonte (JetBrains Mono) carrega DEPOIS: o xterm media a celula com a fonte reserva (mais
    // estreita) -> colunas demais e o texto passava da borda (no celular cortava a direita).
    // Quando a fonte chega, troca o fontFamily (forca medir de novo) e reajusta.
    if (document.fonts?.load) {
      Promise.all([document.fonts.load(`${fontSize}px "JetBrains Mono"`), document.fonts.load(`bold ${fontSize}px "JetBrains Mono"`)])
        .catch(() => {})
        .then(() => {
          if (termRef.current !== term) return
          term.options.fontFamily = FONT.replace('"JetBrains Mono"', "'JetBrains Mono'")
          try { fit.fit() } catch { /* */ }
        })
    }

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
    let lastTouch = 0
    const onCtx = (e) => {
      e.preventDefault()
      // toque longo no Android gera "contextmenu": NAO cola nada (o toque longo abre a selecao)
      if (Date.now() - lastTouch < 1500) return
      if (copySelection()) { term.clearSelection(); return }
      pasteFromClipboard()
    }
    const onAux = (e) => { if (e.button === 1) { e.preventDefault(); pasteFromClipboard() } }
    // selecao do PROPRIO xterm (Shift+arrastar, ou sem mouse no tmux): copia ao soltar o botao
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
    // 1 evento de roda = o tmux rola ~5 linhas; 1 evento a cada 2 linhas de dedo fica natural
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
      // sem mouse no programa (ex.: tela sem tmux) o proprio xterm rola o scrollback
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
      // e.key (e nao e.code): funciona em qualquer layout (AZERTY, ABNT...) e em teclados
      // virtuais/IMEs que nao mandam keyCode
      const key = (e.key || '').toLowerCase()
      // Ctrl+Shift+F = busca
      if (e.ctrlKey && e.shiftKey && key === 'f') { cb.current.onSearchToggle?.(); return false }
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

    fitNow()
    // reajuste: container mudou (rotacao, teclado do celular abriu/fechou, barra de teclas...)
    let raf = 0
    const refit = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { try { fit.fit() } catch { /* */ } }) }
    const ro = new ResizeObserver(refit)
    ro.observe(boxRef.current)
    const vv = window.visualViewport
    vv?.addEventListener('resize', refit)
    window.addEventListener('orientationchange', refit)

    // conexao: volta p/ a aba / volta a rede -> reconecta na hora (ou testa com ping)
    const probe = () => {
      if (st.stopped) return
      const ws = wsRef.current
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) { st.retries = 0; connect(); return }
      if (ws.readyState === WebSocket.OPEN) {
        const sentAt = Date.now()
        ws.send(CTRL + JSON.stringify({ type: 'ping' }))
        // celular acordou com o socket "aberto" mas morto: sem resposta em 4s -> reconecta
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
