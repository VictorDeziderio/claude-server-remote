import { useEffect, useState, useCallback } from 'react'
import {
  UserRound, LogOut, LogIn, Loader2, Check, X, ExternalLink,
  SquareTerminal, ChevronUp, ChevronDown,
} from 'lucide-react'
import * as api from '../api.js'

const findUrls = (txt) => [...new Set((txt.match(/https?:\/\/[^\s'"()\]]+/g) || []))].slice(0, 2)

export default function Account({ data, onFlash, refresh }) {
  const login = data.login || { logged: false, account: '', org: '', method: '' }
  const [showLogin, setShowLogin] = useState(false)
  const [busy, setBusy] = useState(false)

  const doLogout = async () => {
    if (!window.confirm('Deslogar a conta do Claude neste servidor? Você precisará logar de novo para usar o Claude.')) return
    setBusy(true)
    const r = await api.claudeLogout()
    setBusy(false)
    onFlash?.(r)
    refresh?.()
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl bg-ink-800 p-5 ring-1 ring-white/5">
        <div className="flex items-start gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-claude/30"><UserRound className="h-7 w-7 text-claude" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${login.logged ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,.5)]' : 'bg-rose-500'}`} />
              <span className="truncate text-lg font-semibold text-white">{login.logged ? (login.account || 'Conta conectada') : 'Nenhuma conta conectada'}</span>
            </div>
            {login.org && <div className="mt-1 text-sm text-slate-400">organização: {login.org}</div>}
            <div className="mt-1 text-sm text-slate-500">método: {login.method || '—'} · Claude {data.version || '?'}</div>
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          {login.logged ? (
            <button onClick={doLogout} disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-500/15 px-4 py-2 text-sm font-medium text-rose-300 ring-1 ring-rose-500/25 transition hover:bg-rose-500/25 disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />} Deslogar do Claude
            </button>
          ) : (
            <button onClick={() => setShowLogin(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-claude/90 px-4 py-2 text-sm font-medium text-white transition hover:bg-claude">
              <LogIn className="h-4 w-4" /> Logar no Claude
            </button>
          )}
        </div>
      </section>

      <p className="px-1 text-xs text-slate-500">
        O login do Claude é por conta (OAuth): você abre um link, autoriza e cola o código gerado. As credenciais ficam em <code>~/.claude</code> (volume) e persistem entre deploys.
      </p>

      {showLogin && <LoginModal onClose={() => { setShowLogin(false); refresh?.() }} onFlash={onFlash} />}
    </div>
  )
}

function LoginModal({ onClose, onFlash }) {
  const SESS = 'shell'
  const [screen, setScreen] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const capture = useCallback(async () => {
    const r = await api.termCapture(SESS)
    if (r.ok) setScreen(r.content)
  }, [])
  useEffect(() => { capture(); const t = setInterval(capture, 1000); return () => clearInterval(t) }, [capture])

  const start = async () => { setBusy(true); await api.termSend(SESS, 'claude', 'Enter'); setBusy(false); setTimeout(capture, 400) }
  const key = (k) => api.termSend(SESS, '', k).then(() => setTimeout(capture, 150))
  const sendCode = async () => {
    if (!code.trim()) return
    setBusy(true)
    const r = await api.termSend(SESS, code.trim(), 'Enter')
    setBusy(false)
    if (r && r.ok === false) onFlash?.(r)
    setCode(''); setTimeout(capture, 500)
  }
  const urls = findUrls(screen)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl bg-ink-800 p-5 shadow-2xl shadow-black/40 ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white"><LogIn className="h-4 w-4 text-claude" /> Logar no Claude</div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"><X className="h-4 w-4" /></button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button onClick={start} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-claude/90 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-claude disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SquareTerminal className="h-4 w-4" />} Iniciar login
          </button>
          <KeyB onClick={() => key('Up')}><ChevronUp className="h-3.5 w-3.5" /></KeyB>
          <KeyB onClick={() => key('Down')}><ChevronDown className="h-3.5 w-3.5" /></KeyB>
          <KeyB onClick={() => key('Enter')}>Enter</KeyB>
          <KeyB onClick={() => key('C-c')}>Ctrl+C</KeyB>
        </div>

        {urls.length > 0 && (
          <div className="mb-3 rounded-lg bg-claude/5 p-2.5 ring-1 ring-claude/20">
            <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-claude"><ExternalLink className="h-3.5 w-3.5" /> abra para autorizar:</div>
            {urls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="block truncate text-xs text-sky-300 hover:underline">{u}</a>)}
          </div>
        )}

        <pre className="m-0 max-h-[40vh] min-h-[26vh] overflow-auto whitespace-pre-wrap rounded-lg bg-black/70 p-3 font-mono text-[12px] leading-relaxed text-slate-200">{screen || '…'}</pre>

        <div className="mt-3 flex items-center gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendCode() }} placeholder="cole aqui o código/token gerado pelo Claude"
            className="flex-1 rounded-lg bg-ink-900 px-3 py-2 font-mono text-sm text-slate-200 ring-1 ring-white/10 focus:outline-none focus:ring-claude/40" />
          <button onClick={sendCode} disabled={busy || !code.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-claude/90 px-3 py-2 text-sm font-medium text-white transition hover:bg-claude disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enviar código
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">1) "Iniciar login" → 2) escolha "login com a conta" (↑ ↓ Enter) → 3) abra o link e autorize → 4) cole o código e Enviar. Depois feche — a página atualiza.</p>
      </div>
    </div>
  )
}
function KeyB({ onClick, children }) {
  return <button onClick={onClick} className="inline-flex items-center gap-1 rounded-md bg-ink-700/60 px-2 py-1 text-xs text-slate-300 ring-1 ring-white/5 transition hover:bg-ink-500 hover:text-white">{children}</button>
}
