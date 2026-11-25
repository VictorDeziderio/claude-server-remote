import { useEffect, useState } from 'react'
import { LogIn, Lock, User, Loader2, AlertCircle, ShieldCheck } from 'lucide-react'
import Logo from './Logo.jsx'
import { Btn, inputCls } from './ui.jsx'
import { cn } from '../lib/utils.js'
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
  const field = 'flex items-center gap-2 rounded-md border border-input bg-input/20 px-3 transition focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/40'
  const input = 'w-full bg-transparent py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none'

  return (
    <div className="flex h-full items-center justify-center overflow-auto px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm animate-fade-up rounded-lg border border-border bg-card p-7 text-card-foreground">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 grid size-12 place-items-center rounded-xl bg-primary text-brand shadow-sm"><Logo size={26} /></div>
          <h1 className="text-lg font-medium text-foreground">claude<span className="text-brand">/</span>remote</h1>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block size-1.5 rounded-full bg-success" /> entre para acessar o painel
          </p>
        </div>

        {err && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            <AlertCircle className="size-4 shrink-0" /> {err}
          </div>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-muted-foreground">Login</span>
          <div className={field}><User className="size-4 text-muted-foreground" />
            <input value={form.login} onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))} autoFocus autoComplete="username" className={input} placeholder="admin" />
          </div>
        </label>
        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-muted-foreground">Senha</span>
          <div className={field}><Lock className="size-4 text-muted-foreground" />
            <input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} autoComplete="current-password" className={input} placeholder="••••••••" />
          </div>
        </label>
        {need2fa && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-muted-foreground">Código do autenticador (2FA)</span>
            <div className={field}><ShieldCheck className="size-4 text-muted-foreground" />
              <input inputMode="numeric" pattern="[0-9 ]*" maxLength={7} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoComplete="one-time-code" className={cn(input, 'tracking-widest')} placeholder="123 456" />
            </div>
          </label>
        )}

        <Btn type="submit" variant="accent" busy={busy} className="mt-2 w-full justify-center py-2.5">
          <LogIn className="size-4" /> Entrar
        </Btn>
        {ver && <p className="mt-4 text-center text-[10px] text-muted-foreground/60">painel v{ver}</p>}
      </form>
    </div>
  )
}
