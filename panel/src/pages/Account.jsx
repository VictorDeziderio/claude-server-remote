import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { UserRound, LogOut, LogIn, Loader2, Check, ExternalLink, SquareTerminal } from 'lucide-react'
import XTerm from '../components/XTerm.jsx'
import { Btn, Modal, inputCls } from '../components/ui.jsx'
import * as api from '../api.js'

const findUrls = (txt) => [...new Set((txt.match(/https?:\/\/[^\s'"()\]]+/g) || []))].filter((u) => !/claude\.ai\/code\/session/.test(u)).slice(0, 2)

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
        <div className="mt-5 flex flex-wrap gap-2">
          {login.logged ? (
            <Btn variant="danger" busy={busy} onClick={doLogout} className="px-4 py-2 text-sm"><LogOut className="h-4 w-4" /> Deslogar do Claude</Btn>
          ) : (
            <Btn variant="accent" onClick={() => setShowLogin(true)} className="px-4 py-2 text-sm"><LogIn className="h-4 w-4" /> Logar no Claude</Btn>
          )}
          <Link to="/terminal/shell" className="inline-flex items-center gap-2 rounded-lg bg-ink-500 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-ink-500/70"><SquareTerminal className="h-4 w-4" /> Abrir terminal</Link>
        </div>
      </section>

      <p className="px-1 text-xs text-slate-500">
        O login do Claude é por conta (OAuth): você abre um link, autoriza e cola o código gerado. As credenciais ficam em <code>~/.claude</code> (volume) e persistem entre deploys.
      </p>

      {showLogin && <LoginModal onClose={() => { setShowLogin(false); refresh?.() }} onFlash={onFlash} />}
    </div>
  )
}

// Login do Claude dentro de um terminal REAL (sessao shell): dispara `claude`, detecta o link
// OAuth na tela e permite colar o codigo. Tudo interativo — setas/Enter funcionam direto.
function LoginModal({ onClose, onFlash }) {
  const termRef = useRef(null)
  const [urls, setUrls] = useState([])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const scan = useCallback(async () => {
    try { const r = await api.termCapture('shell'); if (r.ok) setUrls(findUrls(r.content)) } catch { /* */ }
  }, [])
  useEffect(() => { scan(); const t = setInterval(scan, 1500); return () => clearInterval(t) }, [scan])

  const start = async () => {
    setBusy(true)
    termRef.current?.send('\x03')        // limpa o que estiver na linha
    setTimeout(() => { termRef.current?.send('claude\r'); setBusy(false); termRef.current?.focus() }, 150)
  }
  const sendCode = () => {
    if (!code.trim()) return
    termRef.current?.send(code.trim() + '\r')
    setCode('')
    onFlash?.({ ok: true, msg: 'código enviado ao Claude — acompanhe no terminal' })
  }

  return (
    <Modal title="Logar no Claude" icon={LogIn} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Btn variant="accent" busy={busy} onClick={start}><SquareTerminal className="h-4 w-4" /> Iniciar login (roda <code>claude</code>)</Btn>
        <span className="text-xs text-slate-500">use ↑ ↓ Enter direto no terminal</span>
      </div>

      {urls.length > 0 && (
        <div className="mb-3 rounded-lg bg-claude/5 p-2.5 ring-1 ring-claude/20">
          <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-claude"><ExternalLink className="h-3.5 w-3.5" /> abra para autorizar:</div>
          {urls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="block truncate text-xs text-sky-300 hover:underline">{u}</a>)}
        </div>
      )}

      <div className="h-[45vh] overflow-hidden rounded-lg ring-1 ring-white/10">
        <XTerm ref={termRef} target="shell" fontSize={12} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendCode() }} placeholder="cole aqui o código gerado pelo Claude (ou cole direto no terminal)"
          className={`flex-1 font-mono ${inputCls} px-3 py-2`} />
        <Btn variant="accent" disabled={!code.trim()} onClick={sendCode}><Check className="h-4 w-4" /> Enviar código</Btn>
      </div>
      <p className="mt-2 text-xs text-slate-500">1) "Iniciar login" → 2) escolha o login com a conta (↑ ↓ Enter) → 3) abra o link e autorize → 4) cole o código. Depois feche — a página atualiza.</p>
    </Modal>
  )
}
