import { useEffect, useState } from 'react'
import { LogIn, Lock, User, Loader2, AlertCircle, ShieldCheck } from 'lucide-react'
import Logo from './Logo.jsx'
import { login, loginInfo } from '../api.js'

export default function Login({ onSuccess }) {
  const [form, setForm] = useState({ login: '', password: '', code: '' })
  const [need2fa, setNeed2fa] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ver, setVer] = useState('')

  useEffect(() => { loginInfo().then((r) => { if (r && r.twofa) setNeed2fa(true); if (r && r.panelVersion) setVer(r.panelVersion) }).catch(() => {}) }, [])

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = await login(form.login.trim(), form.password, form.code.trim())
      if (r.ok) onSuccess()
      else { if (r.need2fa) setNeed2fa(true); setErr(r.msg || 'login ou senha incorretos') }
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }
  const field = 'flex items-center gap-2 rounded-xl bg-ink-900 px-3 ring-1 ring-white/10 transition focus-within:ring-2 focus-within:ring-claude/50'
  const input = 'w-full bg-transparent py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none'

  return (
    <div className="flex h-full items-center justify-center overflow-auto px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm animate-fade-up rounded-3xl bg-ink-800 p-7 shadow-elevated ring-1 ring-white/6">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-claude/30"><Logo size={32} /></div>
          <h1 className="text-display text-white">Claude <span className="text-claude">Remote</span></h1>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-slate-500">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-live-400 shadow-[0_0_6px_1px_rgba(79,224,203,.5)]" /> entre para acessar o painel
          </p>
        </div>

        {err && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-200 ring-1 ring-rose-500/25" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" /> {err}
          </div>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-slate-400">Login</span>
          <div className={field}><User className="h-4 w-4 text-slate-500" />
            <input value={form.login} onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))} autoFocus autoComplete="username" className={input} placeholder="admin" />
          </div>
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-slate-400">Senha</span>
          <div className={field}><Lock className="h-4 w-4 text-slate-500" />
            <input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} autoComplete="current-password" className={input} placeholder="••••••••" />
          </div>
        </label>
        {need2fa && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-slate-400">Código do autenticador (2FA)</span>
            <div className={field}><ShieldCheck className="h-4 w-4 text-slate-500" />
              <input inputMode="numeric" pattern="[0-9 ]*" maxLength={7} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoComplete="one-time-code" className={`${input} font-mono tracking-widest`} placeholder="123 456" />
            </div>
          </label>
        )}

        <button type="submit" disabled={busy}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-claude py-2.5 text-sm font-semibold text-white transition duration-150 hover:bg-claude-600 hover:shadow-glow-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-claude/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-800 disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Entrar
        </button>
        {ver && <p className="mt-4 text-center font-mono text-mono-sm text-slate-600">painel v{ver}</p>}
      </form>
    </div>
  )
}
