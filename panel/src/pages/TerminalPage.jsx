import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { SquareTerminal, Cpu, Maximize2, Minimize2, RefreshCw, ClipboardPaste, Eraser, ZoomIn, ZoomOut, Keyboard, Wifi, WifiOff, Loader2, AlertTriangle, Search, ChevronUp, ChevronDown, X, PanelRightOpen, PanelRightClose, Plus, AppWindow, Users, LogIn, Power, TextSelect, Ellipsis, Copy, Send } from 'lucide-react'
import XTerm from '../components/XTerm.jsx'
import Files from '../components/Files.jsx'
import { Dot, IconBtn, ActivityDot, Btn, Modal, inputCls } from '../components/ui.jsx'
import { Separator } from '../components/ui/separator.jsx'
import { cn } from '../lib/utils.js'
import { copyText } from '../lib/clipboard.js'
import { EXTRA_KEYS, CLAUDE_ACTIONS, cycleMod, afterUse, applyModifiers, isUserInput, clampFont, defaultFont } from '../lib/termkeys.js'
import * as api from '../api.js'
import { t, tOr } from '../lib/i18n.js'
import { TR } from '../lib/i18n-rich.jsx'

const LS_FONT = 'cr.term.font',
  LS_KEYS = 'cr.term.keys',
  LS_SIDE = 'cr.term.side',
  LS_SIDEW = 'cr.term.sidew'
const readLS = (k, d) => {
  try {
    const v = localStorage.getItem(k)
    return v == null ? d : JSON.parse(v)
  } catch {
    return d
  }
}
const writeLS = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* */
  }
}
const narrow = () => window.matchMedia('(max-width: 768px)').matches
const coarse = () => window.matchMedia('(pointer: coarse)').matches

const STATUS = {
  connecting: { get label() { return t('term.connecting') }, Icon: Loader2, cls: 'text-amber-600 dark:text-amber-300', spin: true },
  open: { get label() { return t('term.connected') }, Icon: Wifi, cls: 'text-success drop-shadow-[0_0_6px_rgba(79,224,203,.5)]' },
  closed: { get label() { return t('term.reconnectingShort') }, Icon: WifiOff, cls: 'text-amber-600 dark:text-amber-300' },
  error: { get label() { return t('term.error') }, Icon: AlertTriangle, cls: 'text-rose-600 dark:text-rose-300' },
}

// Botao da barra de teclas: NAO tira o foco do terminal (senao o teclado do celular fecha) e,
// nas teclas com repeat (setas/PgUp/PgDn), segurar repete.
function KeyBtn({ k, onPress, active, locked, hot }) {
  const rep = useRef({ delay: null, rep: null, repeated: false })
  const stop = () => { clearTimeout(rep.current.delay); clearInterval(rep.current.rep) }
  useEffect(() => stop, [])
  const down = (e) => {
    e.preventDefault()
    if (!k.repeat) return
    rep.current.repeated = false
    stop()
    rep.current.delay = setTimeout(() => {
      rep.current.rep = setInterval(() => { rep.current.repeated = true; onPress(k) }, 70)
    }, 380)
  }
  return (
    <button
      type="button"
      title={tOr('key.' + k.id, k.title)}
      aria-pressed={k.mod ? active : undefined}
      onPointerDown={down}
      onMouseDown={(e) => e.preventDefault()}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={() => { if (!rep.current.repeated) onPress(k); rep.current.repeated = false }}
      className={cn(
        'h-10 min-w-[2.75rem] shrink-0 select-none rounded-md border px-2.5 font-mono text-[13px] transition active:scale-95 sm:h-8 sm:min-w-0 sm:text-xs',
        active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-accent text-foreground hover:bg-secondary hover:text-primary-foreground active:bg-primary/30',
        locked && 'underline decoration-2 underline-offset-4',
        hot && 'border-destructive/60 text-destructive',
      )}
    >
      {k.label}
    </button>
  )
}

// "Selecionar texto": o historico do tmux como TEXTO normal da pagina -> a selecao nativa do
// celular (segurar + arrastar as alcas + Copiar) funciona; no xterm/tmux o dedo nao seleciona.
function SelectSheet({ target, font, onClose, onFlash }) {
  const [text, setText] = useState(null)
  const preRef = useRef(null)
  useEffect(() => {
    api.termCapture(target, 2000)
      .then((r) => setText(r.ok ? r.content : `[${r.msg || t('term.error')}]`))
      .catch((e) => setText(`[${e.message}]`))
  }, [target])
  useEffect(() => {
    if (text != null && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [text])
  const copy = async (all) => {
    const sel = all ? '' : String(window.getSelection?.() || '')
    const s = sel || text || ''
    const ok = await copyText(s)
    onFlash?.(ok ? { ok: true, msg: t('term.copied', { n: s.length }) } : { ok: false, msg: t('term.copyBlockedMobile') })
    if (ok) onClose()
  }
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" role="dialog" aria-modal="true" aria-label={t('term.select')}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <TextSelect className="size-4 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t('term.select')}</span>
        <Btn variant="accent" onClick={() => copy(false)}><Copy className="size-4" /> {t('term.copy')}</Btn>
        <IconBtn title={t('nav.closeLower')} onClick={onClose}><X className="size-4" /></IconBtn>
      </div>
      <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{t('term.selectHint')}</p>
      <pre ref={preRef} className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-all bg-black p-3 font-mono leading-snug text-[#E8E6E1]" style={{ fontSize: font, WebkitUserSelect: 'text', userSelect: 'text' }}>
        {text == null ? t('common.loading') : text}
      </pre>
    </div>
  )
}

// (the Modal sits above the fullscreen terminal: see the layers in components/ui.jsx)
// Colar sem permissao de leitura da area de transferencia (HTTP, iOS negou...): caixa de texto
// onde o "Colar" nativo do celular funciona sempre.
function PasteSheet({ onSend, onClose }) {
  const [v, setV] = useState('')
  return (
    <Modal title={t('term.pasteTitle')} icon={ClipboardPaste} onClose={onClose}>
      <p className="mb-2 text-xs text-muted-foreground">{t('term.pasteHint')}</p>
      <textarea autoFocus value={v} onChange={(e) => setV(e.target.value)} rows={5} className={cn(inputCls, 'w-full font-mono')} placeholder={t('term.pasteHere')} />
      <div className="mt-3 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
        <Btn variant="accent" disabled={!v} onClick={() => onSend(v)}><Send className="size-4" /> {t('common.send')}</Btn>
      </div>
    </Modal>
  )
}

// /terminal/:name -> "shell" (bash em /root) ou nome de um projeto (sessao claude-<projeto>)
export default function TerminalPage({ data, activity, onFlash }) {
  const { name = 'shell' } = useParams()
  const navigate = useNavigate()
  const termRef = useRef(null)
  const [status, setStatus] = useState('connecting')
  const [statusMsg, setStatusMsg] = useState('')
  const [statusInfo, setStatusInfo] = useState({})
  const [font, setFont] = useState(() => clampFont(readLS(LS_FONT, defaultFont(narrow()))))
  const [keys, setKeys] = useState(() => readLS(LS_KEYS, narrow()))
  const [full, setFull] = useState(false)
  const [detach, setDetach] = useState(false)
  const [search, setSearch] = useState(null) // null | string
  const [side, setSide] = useState(() => readLS(LS_SIDE, false))
  const [sideW, setSideW] = useState(() => readLS(LS_SIDEW, 420))
  const [sidePath, setSidePath] = useState('')
  const [win, setWin] = useState({ windows: [], clients: 0 })
  const [killIdx, setKillIdx] = useState(null)
  const [mods, setMods] = useState({ ctrl: 'off', alt: 'off' })
  const [menu, setMenu] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [pasting, setPasting] = useState(false)
  const searchRef = useRef(null)
  const dragRef = useRef(null)
  const modsRef = useRef(mods)
  modsRef.current = mods
  const pinchRef = useRef(font)
  const fontRef = useRef(font)
  fontRef.current = font

  const projects = data?.projects || []
  const target = name === 'shell' || projects.some((p) => p.name === name) ? name : 'shell'
  useEffect(() => {
    if (target !== name) navigate('/terminal/shell', { replace: true })
  }, [target, name, navigate])
  useEffect(() => {
    setSidePath(target === 'shell' ? '' : 'projects/' + target)
    setDetach(false)
  }, [target])

  const onStatus = useCallback((s, msg, info) => {
    setStatus(s)
    setStatusMsg(msg || '')
    setStatusInfo(info || {})
  }, [])
  const onCopy = useCallback((ok, text) => onFlash?.(ok ? { ok: true, msg: t('term.copied', { n: text.length }) } : { ok: false, msg: t('term.copyBlocked') }), [onFlash])
  const powerOn = async () => {
    const r = await api.setPower(target, true).catch((e) => ({ ok: false, msg: e.message }))
    onFlash?.(r)
    if (r.ok) setTimeout(() => termRef.current?.reconnect(), 400)
  }
  const setFontSafe = useCallback((n) => {
    const v = clampFont(n)
    if (v === fontRef.current) return
    setFont(v)
    writeLS(LS_FONT, v)
  }, [])
  const toggleKeys = () =>
    setKeys((k) => {
      writeLS(LS_KEYS, !k)
      return !k
    })
  const toggleSide = () =>
    setSide((s) => {
      writeLS(LS_SIDE, !s)
      return !s
    })

  // Ctrl/Alt grudentos: aplicados a PROXIMA tecla do teclado do celular (ou da barra)
  const withMods = useCallback((d) => {
    const m = modsRef.current
    if ((m.ctrl === 'off' && m.alt === 'off') || !isUserInput(d)) return d
    const out = applyModifiers(d, { ctrl: m.ctrl !== 'off', alt: m.alt !== 'off' })
    const next = { ctrl: afterUse(m.ctrl), alt: afterUse(m.alt) }
    modsRef.current = next
    setMods(next)
    return out
  }, [])
  // no celular NAO devolve o foco ao terminal (abriria o teclado a cada toque num botao)
  const refocus = () => { if (!coarse()) termRef.current?.focus() }
  const paste = async () => {
    const ok = await termRef.current?.paste()
    if (!ok) setPasting(true)
  }
  const pressKey = (k) => {
    if (k.mod) {
      setMods((m) => {
        const next = { ...m, [k.mod]: cycleMod(m[k.mod]) }
        modsRef.current = next
        return next
      })
      return
    }
    if (k.action === 'paste') return paste()
    termRef.current?.send(withMods(k.seq))
    refocus()
  }
  const pressAction = (a) => {
    termRef.current?.send(a.seq)
    termRef.current?.scrollToBottom()
    refocus()
  }
  const toggleSearch = useCallback(() => setSearch((s) => (s === null ? '' : null)), [])
  const onLongPress = useCallback(() => setSelecting(true), [])
  const onPinch = useCallback((scale, phase) => {
    if (phase === 'start') pinchRef.current = fontRef.current
    else if (phase === 'move') setFontSafe(pinchRef.current * scale)
  }, [setFontSafe])

  // janelas do tmux (lista a cada 5s enquanto a pagina esta aberta)
  const loadWin = useCallback(
    () =>
      api
        .termWindows(target)
        .then((r) => {
          if (r.ok) setWin(r)
        })
        .catch(() => {}),
    [target],
  )
  useEffect(() => {
    loadWin()
    const t = setInterval(loadWin, 5000)
    return () => clearInterval(t)
  }, [loadWin])
  // conectou (ou reconectou): atualiza logo a lista de janelas/clientes
  useEffect(() => { if (status === 'open') loadWin() }, [status, loadWin])
  const winAction = async (action, index) => {
    const r = await api.termWindow(target, action, index)
    if (r.msg) onFlash?.(r)
    setKillIdx(null)
    loadWin()
    refocus()
  }

  useEffect(() => {
    if (!full) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape' && e.shiftKey) setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])
  useEffect(() => {
    setTimeout(() => termRef.current?.fit(), 60)
  }, [full, keys, side, sideW, search, target])
  useEffect(() => {
    if (search !== null) setTimeout(() => searchRef.current?.focus(), 30)
    else termRef.current?.clearSearch()
  }, [search])
  useEffect(() => {
    if (!menu) return undefined
    const close = () => setMenu(false)
    const t = setTimeout(() => document.addEventListener('click', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('click', close) }
  }, [menu])

  // redimensiona o painel lateral arrastando a divisoria
  const onDragStart = (e) => {
    e.preventDefault()
    const startX = e.clientX,
      startW = sideW
    const move = (ev) => setSideW(Math.max(280, Math.min(window.innerWidth * 0.7, startW - (ev.clientX - startX))))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      dragRef.current = null
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    dragRef.current = up
  }
  // se a pagina trocar de alvo/desmontar no meio do arrasto, os listeners em `window` ficavam
  // presos (dragRef nunca era lido) reagindo a todo mousemove da pagina ate o proximo mouseup
  useEffect(() => () => dragRef.current?.(), [])
  useEffect(() => {
    writeLS(LS_SIDEW, sideW)
  }, [sideW])

  const S = STATUS[status] || STATUS.connecting
  const proj = projects.find((p) => p.name === target)
  const actOf = (p) => (activity && activity[p.session] && activity[p.session].state) || p.activity || 'off'
  const waiting = proj && proj.claudeRunning && actOf(proj) === 'prompt'
  const tabCls = (active) => `relative flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:h-auto sm:py-1.5 sm:text-xs ${active ? 'border border-transparent bg-primary/15 text-primary ring-1 ring-primary/25' : 'bg-accent text-muted-foreground border hover:bg-secondary hover:text-foreground'}`
  const lost = status === 'closed' || (status === 'connecting' && statusInfo.attempt > 0)
  const menuItem = 'flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm text-foreground hover:bg-muted'

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-card sm:rounded-lg sm:border', full && 'fixed inset-0 z-[60] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:rounded-none')}>
      {/* Barra: sessoes + status + acoes */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 sm:flex-wrap sm:px-3 sm:py-2">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          <button type="button" onClick={() => navigate('/terminal/shell')} className={tabCls(target === 'shell')} title={t('term.shellTitle')}>
            <SquareTerminal className="h-3.5 w-3.5" /> Shell
          </button>
          {projects.map((p) => (
            <button key={p.name} type="button" onClick={() => navigate('/terminal/' + encodeURIComponent(p.name))} className={tabCls(target === p.name)} title={t('term.sessionTitle', { s: p.session, state: p.claudeRunning ? actOf(p) : t('term.claudeStopped') })}>
              {p.claudeRunning ? <ActivityDot state={actOf(p)} /> : <Dot on={false} color="bg-slate-600" />} <span className={p.enabled === false ? 'line-through opacity-60' : ''}>{p.name}</span>
            </button>
          ))}
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${S.cls}`} title={statusMsg || S.label} role="status" aria-label={S.label}>
          <S.Icon className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${S.spin ? 'animate-spin' : ''}`} /> <span className="hidden sm:inline">{S.label}</span>
        </span>
        <div className="hidden items-center gap-1 sm:flex">
          <IconBtn title={t('term.search')} active={search !== null} onClick={toggleSearch}>
            <Search className="h-4 w-4" />
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title={t('term.fontSmaller')} onClick={() => setFontSafe(font - 1)}>
            <ZoomOut className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={t('term.fontBigger')} onClick={() => setFontSafe(font + 1)}>
            <ZoomIn className="h-4 w-4" />
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title={t('term.pasteBtn')} onClick={paste}>
            <ClipboardPaste className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={t('term.selectScroll')} onClick={() => setSelecting(true)}>
            <TextSelect className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={t('term.clearLocal')} onClick={() => termRef.current?.clear()}>
            <Eraser className="h-4 w-4" />
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title={t('term.keysBar')} active={keys} onClick={toggleKeys}>
            <Keyboard className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={side ? t('term.closeFiles') : t('term.openFiles')} active={side} onClick={toggleSide} className="hidden md:inline-flex">
            {side ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title={t('term.reconnect')} onClick={() => termRef.current?.reconnect()}>
            <RefreshCw className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={full ? t('term.exitFull') : t('term.full')} onClick={() => setFull((f) => !f)}>
            {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </IconBtn>
        </div>
      </div>

      {/* Janelas do tmux + clientes (+ ferramentas no celular) */}
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-[11px] sm:flex-wrap sm:px-3 sm:py-1.5">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          <AppWindow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {win.windows.map((w) => (
            <span key={w.index} className={`inline-flex shrink-0 items-center overflow-hidden rounded-md ${w.active ? 'border border-transparent ring-1 ring-primary/25 bg-primary/15 text-primary' : 'border border-border bg-accent text-muted-foreground'}`}>
              <button type="button" onClick={() => winAction('select', w.index)} className="px-2 py-1.5 hover:text-foreground sm:py-0.5" title={t('term.window', { i: w.index, cmd: w.cmd })}>
                {w.index}:{w.name}
              </button>
              {win.windows.length > 1 &&
                (killIdx === w.index ? (
                  <button type="button" onClick={() => winAction('kill', w.index)} className="bg-rose-500/20 px-1.5 py-1.5 text-rose-700 dark:text-rose-200 sm:py-0.5" title={t('term.confirmClose')}>
                    {t('term.closeQ')}
                  </button>
                ) : (
                  <button type="button" onClick={() => setKillIdx(w.index)} className="px-1.5 py-1.5 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-300 sm:px-1 sm:py-0.5" title={t('term.closeWindow')}>
                    <X className="h-3 w-3" />
                  </button>
                ))}
            </span>
          ))}
          <button type="button" onClick={() => winAction('new')} className="inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-accent px-2 py-1.5 text-muted-foreground hover:text-foreground sm:px-1.5 sm:py-0.5" title={t('term.newWindow')}>
            <Plus className="h-3 w-3" />
          </button>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 pl-1 text-muted-foreground" title={t('term.clients')}>
            <Users className="h-3 w-3" /> {win.clients}
          </span>
          {win.clients > 1 && !detach && (
            <button type="button" onClick={() => setDetach(true)} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-amber-600 dark:text-amber-300 ring-1 ring-amber-500/25 hover:bg-amber-500/20 sm:py-0.5" title={t('term.takeOverTitle')}>
              <LogIn className="h-3 w-3" /> {t('term.takeOver')}
            </button>
          )}
        </div>
        {/* ferramentas no celular: fonte, selecionar texto, teclas, mais */}
        <div className="flex shrink-0 items-center gap-1 sm:hidden">
          <IconBtn title={t('term.fontSmaller')} onClick={() => setFontSafe(font - 1)}><ZoomOut className="h-4 w-4" /></IconBtn>
          <IconBtn title={t('term.fontBigger')} onClick={() => setFontSafe(font + 1)}><ZoomIn className="h-4 w-4" /></IconBtn>
          <IconBtn title={t('term.select')} onClick={() => setSelecting(true)}><TextSelect className="h-4 w-4" /></IconBtn>
          <IconBtn title={t('term.extraKeys')} active={keys} onClick={toggleKeys}><Keyboard className="h-4 w-4" /></IconBtn>
          <div className="relative">
            <IconBtn title={t('term.more')} active={menu} onClick={() => setMenu((m) => !m)}><Ellipsis className="h-4 w-4" /></IconBtn>
            {menu && (
              <div className="absolute right-0 top-full z-[65] mt-1 w-56 rounded-lg border border-border bg-popover p-1 shadow-xl" role="menu">
                <button type="button" className={menuItem} onClick={paste}><ClipboardPaste className="size-4" /> {t('term.paste')}</button>
                <button type="button" className={menuItem} onClick={toggleSearch}><Search className="size-4" /> {t('term.searchShort')}</button>
                <button type="button" className={menuItem} onClick={() => termRef.current?.clear()}><Eraser className="size-4" /> {t('term.clearShort')}</button>
                <button type="button" className={menuItem} onClick={() => termRef.current?.reconnect()}><RefreshCw className="size-4" /> {t('term.reconnectShort')}</button>
                <button type="button" className={menuItem} onClick={() => setFull((f) => !f)}>{full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />} {full ? t('term.exitFullShort') : t('term.fullShort')}</button>
                <div className="px-3 pb-1.5 pt-1 text-[11px] text-muted-foreground">{t('term.fontInfo', { n: font })}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Busca */}
      {search !== null && (
        <form
          className="flex items-center gap-1.5 border-b border-border px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            termRef.current?.findNext(search)
          }}
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              termRef.current?.findNext(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setSearch(null)
              if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault()
                termRef.current?.findPrevious(search)
              }
            }}
            placeholder={t('term.searchPh')}
            className={`${inputCls} min-w-0 flex-1 py-1 sm:w-72 sm:flex-none`}
          />
          <IconBtn title={t('term.prev')} onClick={() => termRef.current?.findPrevious(search)}>
            <ChevronUp className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn title={t('term.next')} onClick={() => termRef.current?.findNext(search)}>
            <ChevronDown className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn title={t('term.closeEsc')} onClick={() => setSearch(null)}>
            <X className="h-3.5 w-3.5" />
          </IconBtn>
        </form>
      )}

      {/* Terminal (+ arquivos ao lado) */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 sm:p-1">
          <XTerm ref={termRef} target={target} fontSize={font} detach={detach} onStatus={onStatus} onSearchToggle={toggleSearch} onCopy={onCopy} onLongPress={onLongPress} onPinch={onPinch} transformInput={withMods} className="sm:rounded-lg" />
          {lost && (
            <div className="absolute inset-x-0 top-2 z-10 mx-auto flex w-fit max-w-[92%] items-center gap-2 rounded-lg bg-amber-950/90 px-3 py-2 text-xs text-amber-800 dark:text-amber-100 ring-1 ring-amber-500/30" role="status">
              <WifiOff className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
              <span>{status === 'closed' ? t('term.lost', { s: Math.max(1, Math.round((statusInfo.retryIn || 0) / 1000)) }) : t('term.reconnAttempt', { n: statusInfo.attempt })}</span>
              <button type="button" className="rounded-md bg-amber-500/20 px-2.5 py-1.5 font-medium text-amber-800 dark:text-amber-100 ring-1 ring-amber-500/40 hover:bg-amber-500/30" onClick={() => termRef.current?.reconnect()}>
                {t('term.reconnectNow')}
              </button>
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-x-0 bottom-3 z-10 mx-auto flex w-fit max-w-[92%] flex-wrap items-center gap-2 rounded-lg bg-rose-950/90 px-3 py-2 text-xs text-rose-800 dark:text-rose-100 ring-1 ring-rose-500/30">
              {statusMsg || t('term.error')} —
              {proj && proj.enabled === false ? (
                <button type="button" className="inline-flex items-center gap-1 rounded-md bg-emerald-500/20 px-2 py-1 text-emerald-700 dark:text-emerald-200 ring-1 ring-emerald-500/30 hover:bg-emerald-500/30" onClick={powerOn}>
                  <Power className="h-3 w-3" /> {t('term.powerOn')}
                </button>
              ) : (
                <button type="button" className="underline" onClick={() => termRef.current?.reconnect()}>
                  {t('common.retry')}
                </button>
              )}
            </div>
          )}
        </div>
        {side && (
          <>
            <div onMouseDown={onDragStart} className="hidden w-1.5 shrink-0 cursor-col-resize bg-border transition hover:bg-primary/40 md:block" title={t('term.drag')} />
            <div className="hidden min-h-0 shrink-0 p-1 md:block" style={{ width: sideW }}>
              <Files path={sidePath} onNavigate={setSidePath} onFlash={onFlash} embedded />
            </div>
          </>
        )}
      </div>

      {/* Barras de teclas (celular): atalhos do Claude + teclas extras */}
      {keys && (
        <div className="border-t border-border bg-sidebar">
          {target !== 'shell' && (
            <div className="no-scrollbar flex items-center gap-1 overflow-x-auto px-2 pt-1.5" aria-label={t('term.claudeKeys')}>
              <span className={cn('shrink-0 pr-1 text-[10px] uppercase tracking-wide', waiting ? 'text-destructive' : 'text-muted-foreground')}>{waiting ? t('term.waiting') : 'claude'}</span>
              {CLAUDE_ACTIONS.map((a) => (
                <KeyBtn key={a.id} k={a} onPress={pressAction} hot={waiting && /^a\d$/.test(a.id)} />
              ))}
            </div>
          )}
          <div className="no-scrollbar flex items-center gap-1 overflow-x-auto px-2 py-1.5" aria-label={t('term.extraKeys')}>
            {EXTRA_KEYS.map((k) => (
              <KeyBtn key={k.id} k={k} onPress={pressKey} active={k.mod ? mods[k.mod] !== 'off' : false} locked={k.mod ? mods[k.mod] === 'lock' : false} />
            ))}
          </div>
        </div>
      )}

      {!full && (
        <p className="hidden flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-xs text-muted-foreground sm:flex">
          <span className="inline-flex items-center gap-1 font-mono">
            <Cpu className="h-3 w-3" /> {proj ? t('term.sessionIn', { s: proj.session, dir: proj.dir }) : t('term.shellTitle')}
          </span>
          <span>{t('term.tabHint')}</span>
          <span>{t('term.mouseHint')}</span>
          {target === 'shell' && (
            <span>
              <TR k="term.forClaude" />
            </span>
          )}
        </p>
      )}

      {selecting && <SelectSheet target={target} font={Math.max(12, font)} onClose={() => setSelecting(false)} onFlash={onFlash} />}
      {pasting && <PasteSheet onClose={() => setPasting(false)} onSend={(t) => { termRef.current?.pasteText(t); setPasting(false) }} />}
    </div>
  )
}
