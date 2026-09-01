import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  SquareTerminal, Cpu, Maximize2, Minimize2, RefreshCw, ClipboardPaste, Eraser,
  ZoomIn, ZoomOut, Keyboard, Wifi, WifiOff, Loader2, AlertTriangle,
} from 'lucide-react'
import XTerm from '../components/XTerm.jsx'
import { Dot, IconBtn } from '../components/ui.jsx'

const LS_FONT = 'cr.term.font'
const LS_KEYS = 'cr.term.keys'
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* */ } }

// barra de teclas (mobile/tablet): sequencias enviadas direto ao PTY
const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['^C', '\x03'], ['^D', '\x04'], ['^Z', '\x1a'], ['^L', '\x0c'], ['^R', '\x12'],
  ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Home', '\x1b[H'], ['End', '\x1b[F'],
  ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'], ['Enter', '\r'],
]

const STATUS = {
  connecting: { label: 'conectando…', Icon: Loader2, cls: 'text-amber-300', spin: true },
  open: { label: 'conectado', Icon: Wifi, cls: 'text-emerald-300' },
  closed: { label: 'reconectando…', Icon: WifiOff, cls: 'text-amber-300' },
  error: { label: 'erro', Icon: AlertTriangle, cls: 'text-rose-300' },
}

// /terminal/:name  -> "shell" (bash em /root) ou nome de um projeto (sessao claude-<projeto>)
export default function TerminalPage({ data }) {
  const { name = 'shell' } = useParams()
  const navigate = useNavigate()
  const termRef = useRef(null)
  const [status, setStatus] = useState('connecting')
  const [statusMsg, setStatusMsg] = useState('')
  const [font, setFont] = useState(() => readLS(LS_FONT, 13))
  const [keys, setKeys] = useState(() => readLS(LS_KEYS, window.matchMedia('(max-width: 768px)').matches))
  const [full, setFull] = useState(false)

  const projects = data?.projects || []
  const target = name === 'shell' || projects.some((p) => p.name === name) ? name : 'shell'
  useEffect(() => { if (target !== name) navigate('/terminal/shell', { replace: true }) }, [target, name, navigate])

  const onStatus = useCallback((s, msg) => { setStatus(s); setStatusMsg(msg || '') }, [])
  const setFontSafe = (n) => { const v = Math.min(22, Math.max(10, n)); setFont(v); writeLS(LS_FONT, v) }
  const toggleKeys = () => setKeys((k) => { writeLS(LS_KEYS, !k); return !k })
  const press = (seq) => { termRef.current?.send(seq); termRef.current?.focus() }

  useEffect(() => {
    if (!full) return undefined
    const onKey = (e) => { if (e.key === 'Escape' && e.shiftKey) setFull(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])
  useEffect(() => { setTimeout(() => termRef.current?.fit(), 50) }, [full, keys])

  const S = STATUS[status] || STATUS.connecting
  const proj = projects.find((p) => p.name === target)

  const tabCls = (active) => `flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
    active ? 'bg-claude/15 text-claude ring-1 ring-claude/25' : 'bg-ink-700/60 text-slate-400 ring-1 ring-white/5 hover:bg-ink-500 hover:text-slate-200'}`

  return (
    <div className={`flex min-h-0 flex-1 flex-col rounded-2xl bg-ink-800 ring-1 ring-white/5 ${full ? 'fixed inset-0 z-50 rounded-none' : ''}`}>
      {/* Barra: sessoes + status + acoes */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          <button type="button" onClick={() => navigate('/terminal/shell')} className={tabCls(target === 'shell')} title="bash em /root (sessão cr-shell)">
            <SquareTerminal className="h-3.5 w-3.5" /> Shell
          </button>
          {projects.map((p) => (
            <button key={p.name} type="button" onClick={() => navigate('/terminal/' + encodeURIComponent(p.name))} className={tabCls(target === p.name)} title={`sessão ${p.session || 'claude-' + p.name}`}>
              <Dot on={p.claudeRunning} /> {p.name}
            </button>
          ))}
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs ${S.cls}`} title={statusMsg}>
          <S.Icon className={`h-3.5 w-3.5 ${S.spin ? 'animate-spin' : ''}`} /> {S.label}
        </span>
        <div className="flex items-center gap-1">
          <IconBtn title="diminuir fonte" onClick={() => setFontSafe(font - 1)}><ZoomOut className="h-4 w-4" /></IconBtn>
          <IconBtn title="aumentar fonte" onClick={() => setFontSafe(font + 1)}><ZoomIn className="h-4 w-4" /></IconBtn>
          <IconBtn title="colar da área de transferência" onClick={() => termRef.current?.paste()}><ClipboardPaste className="h-4 w-4" /></IconBtn>
          <IconBtn title="limpar a tela (local)" onClick={() => termRef.current?.clear()}><Eraser className="h-4 w-4" /></IconBtn>
          <IconBtn title="barra de teclas (Esc, Tab, Ctrl…)" active={keys} onClick={toggleKeys}><Keyboard className="h-4 w-4" /></IconBtn>
          <IconBtn title="reconectar" onClick={() => termRef.current?.reconnect()}><RefreshCw className="h-4 w-4" /></IconBtn>
          <IconBtn title={full ? 'sair da tela cheia (Shift+Esc)' : 'tela cheia'} onClick={() => setFull((f) => !f)}>{full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</IconBtn>
        </div>
      </div>

      {/* Terminal */}
      <div className="relative min-h-0 flex-1 p-1">
        <XTerm ref={termRef} target={target} fontSize={font} onStatus={onStatus} className="rounded-lg" />
        {status === 'error' && (
          <div className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-lg bg-rose-950/90 px-3 py-2 text-xs text-rose-100 ring-1 ring-rose-500/30">
            {statusMsg || 'erro'} — <button type="button" className="underline" onClick={() => termRef.current?.reconnect()}>tentar de novo</button>
          </div>
        )}
      </div>

      {/* Barra de teclas (mobile) */}
      {keys && (
        <div className="flex gap-1 overflow-x-auto border-t border-white/5 px-2 py-1.5">
          {KEYS.map(([label, seq]) => (
            <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => press(seq)}
              className="shrink-0 rounded-md bg-ink-700/60 px-2.5 py-1.5 font-mono text-xs text-slate-300 ring-1 ring-white/5 transition hover:bg-ink-500 hover:text-white active:bg-claude/30">
              {label}
            </button>
          ))}
        </div>
      )}

      {!full && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/5 px-3 py-1.5 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1"><Cpu className="h-3 w-3" /> {proj ? `sessão ${proj.session || 'claude-' + proj.name} em ${proj.dir}` : 'bash em /root (sessão cr-shell)'}</span>
          <span>· fechar a aba não encerra a sessão</span>
          <span>· Ctrl+Shift+C copia · Ctrl+Shift+V cola · Shift+arrastar seleciona · roda do mouse rola o histórico</span>
          {target === 'shell' && <span>· para o Claude: <code className="text-slate-400">claude</code> ou <code className="text-slate-400">tmux attach -t claude-&lt;projeto&gt;</code></span>}
        </p>
      )}
    </div>
  )
}
