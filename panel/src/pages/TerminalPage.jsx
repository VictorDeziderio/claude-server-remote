import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { SquareTerminal, Cpu, Maximize2, Minimize2, RefreshCw, ClipboardPaste, Eraser, ZoomIn, ZoomOut, Keyboard, Wifi, WifiOff, Loader2, AlertTriangle, Search, ChevronUp, ChevronDown, X, PanelRightOpen, PanelRightClose, Plus, AppWindow, Users, LogIn, Power } from 'lucide-react'
import XTerm from '../components/XTerm.jsx'
import Files from '../components/Files.jsx'
import { Dot, IconBtn, ActivityDot, inputCls } from '../components/ui.jsx'
import { Separator } from '../components/ui/separator.jsx'
import * as api from '../api.js'

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

// barra de teclas (mobile/tablet): sequencias enviadas direto ao PTY
const KEYS = [
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['^C', '\x03'],
  ['^D', '\x04'],
  ['^Z', '\x1a'],
  ['^L', '\x0c'],
  ['^R', '\x12'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['Home', '\x1b[H'],
  ['End', '\x1b[F'],
  ['PgUp', '\x1b[5~'],
  ['PgDn', '\x1b[6~'],
  ['Enter', '\r'],
]
const STATUS = {
  connecting: { label: 'conectando…', Icon: Loader2, cls: 'text-amber-300', spin: true },
  open: { label: 'conectado', Icon: Wifi, cls: 'text-success drop-shadow-[0_0_6px_rgba(79,224,203,.5)]' },
  closed: { label: 'reconectando…', Icon: WifiOff, cls: 'text-amber-300' },
  error: { label: 'erro', Icon: AlertTriangle, cls: 'text-rose-300' },
}

// /terminal/:name -> "shell" (bash em /root) ou nome de um projeto (sessao claude-<projeto>)
export default function TerminalPage({ data, activity, onFlash }) {
  const { name = 'shell' } = useParams()
  const navigate = useNavigate()
  const termRef = useRef(null)
  const [status, setStatus] = useState('connecting')
  const [statusMsg, setStatusMsg] = useState('')
  const [font, setFont] = useState(() => readLS(LS_FONT, 13))
  const [keys, setKeys] = useState(() => readLS(LS_KEYS, window.matchMedia('(max-width: 768px)').matches))
  const [full, setFull] = useState(false)
  const [detach, setDetach] = useState(false)
  const [search, setSearch] = useState(null) // null | string
  const [side, setSide] = useState(() => readLS(LS_SIDE, false))
  const [sideW, setSideW] = useState(() => readLS(LS_SIDEW, 420))
  const [sidePath, setSidePath] = useState('')
  const [win, setWin] = useState({ windows: [], clients: 0 })
  const [killIdx, setKillIdx] = useState(null)
  const searchRef = useRef(null)
  const dragRef = useRef(null)

  const projects = data?.projects || []
  const target = name === 'shell' || projects.some((p) => p.name === name) ? name : 'shell'
  useEffect(() => {
    if (target !== name) navigate('/terminal/shell', { replace: true })
  }, [target, name, navigate])
  useEffect(() => {
    setSidePath(target === 'shell' ? '' : 'projects/' + target)
    setDetach(false)
  }, [target])

  const onStatus = useCallback((s, msg) => {
    setStatus(s)
    setStatusMsg(msg || '')
  }, [])
  const onCopy = useCallback((ok, text) => onFlash?.(ok ? { ok: true, msg: `copiado (${text.length} caractere${text.length === 1 ? '' : 's'})` } : { ok: false, msg: 'o navegador bloqueou a cópia — use Ctrl+Shift+C' }), [onFlash])
  const powerOn = async () => {
    const r = await api.setPower(target, true).catch((e) => ({ ok: false, msg: e.message }))
    onFlash?.(r)
    if (r.ok) setTimeout(() => termRef.current?.reconnect(), 400)
  }
  const setFontSafe = (n) => {
    const v = Math.min(22, Math.max(10, n))
    setFont(v)
    writeLS(LS_FONT, v)
  }
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
  const press = (seq) => {
    termRef.current?.send(seq)
    termRef.current?.focus()
  }
  const toggleSearch = useCallback(() => setSearch((s) => (s === null ? '' : null)), [])

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
  const winAction = async (action, index) => {
    const r = await api.termWindow(target, action, index)
    if (r.msg) onFlash?.(r)
    setKillIdx(null)
    loadWin()
    termRef.current?.focus()
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
  }, [full, keys, side, sideW, search])
  useEffect(() => {
    if (search !== null) setTimeout(() => searchRef.current?.focus(), 30)
    else termRef.current?.clearSearch()
  }, [search])

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
  const tabCls = (active) => `relative flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${active ? 'border border-transparent bg-primary/15 text-primary ring-1 ring-primary/25 after:absolute after:-bottom-2 after:left-2 after:right-2 after:h-0.5 after:rounded-full after:bg-primary after:content-[""]' : 'bg-accent text-slate-400 border hover:bg-secondary hover:text-slate-200'}`

  return (
    <div className={`flex min-h-0 flex-1 flex-col rounded-lg bg-card border ${full ? 'fixed inset-0 z-50 rounded-none' : ''}`}>
      {/* Barra: sessoes + status + acoes */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          <button type="button" onClick={() => navigate('/terminal/shell')} className={tabCls(target === 'shell')} title="bash em /root (sessão cr-shell)">
            <SquareTerminal className="h-3.5 w-3.5" /> Shell
          </button>
          {projects.map((p) => (
            <button key={p.name} type="button" onClick={() => navigate('/terminal/' + encodeURIComponent(p.name))} className={tabCls(target === p.name)} title={`sessão ${p.session} — ${p.claudeRunning ? actOf(p) : 'Claude parado'}`}>
              {p.claudeRunning ? <ActivityDot state={actOf(p)} /> : <Dot on={false} color="bg-slate-600" />} <span className={p.enabled === false ? 'line-through opacity-60' : ''}>{p.name}</span>
            </button>
          ))}
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs ${S.cls}`} title={statusMsg}>
          <S.Icon className={`h-3.5 w-3.5 ${S.spin ? 'animate-spin' : ''}`} /> <span className="hidden sm:inline">{S.label}</span>
        </span>
        <div className="flex items-center gap-1">
          <IconBtn title="buscar no terminal (Ctrl+Shift+F)" active={search !== null} onClick={toggleSearch}>
            <Search className="h-4 w-4" />
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title="diminuir fonte" onClick={() => setFontSafe(font - 1)}>
            <ZoomOut className="h-4 w-4" />
          </IconBtn>
          <IconBtn title="aumentar fonte" onClick={() => setFontSafe(font + 1)}>
            <ZoomIn className="h-4 w-4" />
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title="colar da área de transferência (ou botão direito)" onClick={() => termRef.current?.paste()}>
            <ClipboardPaste className="h-4 w-4" />
          </IconBtn>
          <IconBtn title="limpar a tela (local)" onClick={() => termRef.current?.clear()}>
            <Eraser className="h-4 w-4" />
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title="barra de teclas (Esc, Tab, Ctrl…)" active={keys} onClick={toggleKeys}>
            <Keyboard className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={side ? 'fechar arquivos' : 'arquivos ao lado (split)'} active={side} onClick={toggleSide} className="hidden md:inline-flex">
            {side ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </IconBtn>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <IconBtn title="reconectar" onClick={() => termRef.current?.reconnect()}>
            <RefreshCw className="h-4 w-4" />
          </IconBtn>
          <IconBtn title={full ? 'sair da tela cheia (Shift+Esc)' : 'tela cheia'} onClick={() => setFull((f) => !f)}>
            {full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </IconBtn>
        </div>
      </div>

      {/* Janelas do tmux + clientes */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px]">
        <AppWindow className="h-3.5 w-3.5 text-slate-500" />
        {win.windows.map((w) => (
          <span key={w.index} className={`inline-flex items-center overflow-hidden rounded-md ${w.active ? 'border border-transparent ring-1 ring-primary/25 bg-primary/15 text-primary' : 'border border-border bg-accent text-slate-400'}`}>
            <button type="button" onClick={() => winAction('select', w.index)} className="px-2 py-0.5 hover:text-white" title={`janela ${w.index} · ${w.cmd}`}>
              {w.index}:{w.name}
            </button>
            {win.windows.length > 1 &&
              (killIdx === w.index ? (
                <button type="button" onClick={() => winAction('kill', w.index)} className="bg-rose-500/20 px-1.5 py-0.5 text-rose-200" title="confirmar fechar">
                  fechar?
                </button>
              ) : (
                <button type="button" onClick={() => setKillIdx(w.index)} className="px-1 py-0.5 text-slate-500 hover:text-rose-300" title="fechar janela">
                  <X className="h-3 w-3" />
                </button>
              ))}
          </span>
        ))}
        <button type="button" onClick={() => winAction('new')} className="inline-flex items-center gap-0.5 rounded-md bg-accent px-1.5 py-0.5 text-slate-400 border hover:text-white" title="nova janela tmux (Ctrl+b c)">
          <Plus className="h-3 w-3" />
        </button>
        <span className="ml-auto inline-flex items-center gap-1 text-slate-500" title="clientes tmux conectados nesta sessão (painel + Console)">
          <Users className="h-3 w-3" /> {win.clients}
        </span>
        {win.clients > 1 && !detach && (
          <button type="button" onClick={() => setDetach(true)} className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-amber-300 ring-1 ring-amber-500/25 hover:bg-amber-500/20" title="derruba os outros clientes (tamanho da tela passa a ser o seu)">
            <LogIn className="h-3 w-3" /> assumir sessão
          </button>
        )}
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
          <Search className="h-3.5 w-3.5 text-slate-500" />
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
            placeholder="buscar no histórico do terminal…"
            className={`${inputCls} w-72 py-1`}
          />
          <IconBtn title="anterior (Shift+Enter)" onClick={() => termRef.current?.findPrevious(search)}>
            <ChevronUp className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn title="próximo (Enter)" onClick={() => termRef.current?.findNext(search)}>
            <ChevronDown className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn title="fechar (Esc)" onClick={() => setSearch(null)}>
            <X className="h-3.5 w-3.5" />
          </IconBtn>
        </form>
      )}

      {/* Terminal (+ arquivos ao lado) */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 p-1">
          <XTerm ref={termRef} target={target} fontSize={font} detach={detach} onStatus={onStatus} onSearchToggle={toggleSearch} onCopy={onCopy} className="rounded-lg" />
          {status === 'error' && (
            <div className="absolute inset-x-0 bottom-3 mx-auto flex w-fit items-center gap-2 rounded-lg bg-rose-950/90 px-3 py-2 text-xs text-rose-100 ring-1 ring-rose-500/30">
              {statusMsg || 'erro'} —
              {proj && proj.enabled === false ? (
                <button type="button" className="inline-flex items-center gap-1 rounded-md bg-emerald-500/20 px-2 py-0.5 text-emerald-200 ring-1 ring-emerald-500/30 hover:bg-emerald-500/30" onClick={powerOn}>
                  <Power className="h-3 w-3" /> ligar o projeto
                </button>
              ) : (
                <button type="button" className="underline" onClick={() => termRef.current?.reconnect()}>
                  tentar de novo
                </button>
              )}
            </div>
          )}
        </div>
        {side && (
          <>
            <div onMouseDown={onDragStart} className="hidden w-1.5 shrink-0 cursor-col-resize bg-border transition hover:bg-primary/40 md:block" title="arraste para redimensionar" />
            <div className="hidden min-h-0 shrink-0 p-1 md:block" style={{ width: sideW }}>
              <Files path={sidePath} onNavigate={setSidePath} onFlash={onFlash} embedded />
            </div>
          </>
        )}
      </div>

      {/* Barra de teclas (mobile) */}
      {keys && (
        <div className="flex gap-1 overflow-x-auto border-t border-border px-2 py-1.5">
          {KEYS.map(([label, seq]) => (
            <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => press(seq)} className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 font-mono text-xs text-slate-300 border transition hover:bg-secondary hover:text-white active:bg-primary/30">
              {label}
            </button>
          ))}
        </div>
      )}

      {!full && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1 font-mono">
            <Cpu className="h-3 w-3" /> {proj ? `sessão ${proj.session} em ${proj.dir}` : 'bash em /root (sessão cr-shell)'}
          </span>
          <span>· fechar a aba não encerra a sessão</span>
          <span>· selecionar com o mouse já copia · Ctrl+C copia a seleção (sem seleção = interromper) · Ctrl+V / botão direito cola · Ctrl+Shift+F busca · roda do mouse rola</span>
          {target === 'shell' && (
            <span>
              · para o Claude: <code className="font-mono text-slate-400">claude</code> ou <code className="font-mono text-slate-400">tmux attach -t claude-&lt;projeto&gt;</code>
            </span>
          )}
        </p>
      )}
    </div>
  )
}
