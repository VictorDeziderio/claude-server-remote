import { useEffect, useState } from 'react'
import { LogIn, Lock, User, Loader2, AlertCircle, ShieldCheck } from 'lucide-react'
import Logo from './Logo.jsx'
import { Btn, inputCls } from './ui.jsx'
import { cn } from '../lib/utils.js'
import { login, loginInfo } from '../api.js'
import { t } from '../lib/i18n.js'

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
      else { if (r.need2fa) setNeed2fa(true); setErr(r.msg || t('login.wrong')) }
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }
  const field = 'flex h-10 items-center gap-2 rounded-md border border-input bg-transparent px-3 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30'
  const input = 'w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground'

  return (
    <div className="relative flex h-full items-center justify-center overflow-auto bg-background px-4 py-10">
      {/* background: faint grid that fades out + a soft glow in the brand color */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_60%_55%_at_50%_45%,#000_30%,transparent_100%)]" />
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[38%] h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/20 blur-3xl" />
      <form onSubmit={submit} className="relative w-full max-w-sm animate-fade-up rounded-xl border bg-card p-6 text-card-foreground shadow-xl sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 grid size-12 place-items-center rounded-xl border bg-background shadow-sm"><Logo size={26} /></div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">claude<span className="text-brand">/</span>remote</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{t('login.hint')}</p>
        </div>

        {err && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            <AlertCircle className="size-4 shrink-0" /> {err}
          </div>
        )}

        <label className="mb-4 block">
          <span className="mb-1.5 block text-sm font-medium">{t('login.user')}</span>
          <div className={field}><User className="size-4 text-muted-foreground" />
            <input value={form.login} onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))} autoFocus autoComplete="username" className={input} placeholder="admin" />
          </div>
        </label>
        <label className="mb-4 block">
          <span className="mb-1.5 block text-sm font-medium">{t('login.password')}</span>
          <div className={field}><Lock className="size-4 text-muted-foreground" />
            <input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} autoComplete="current-password" className={input} placeholder="••••••••" />
          </div>
        </label>
        {need2fa && (
          <label className="mb-4 block">
            <span className="mb-1.5 block text-sm font-medium">{t('login.code')}</span>
            <div className={field}><ShieldCheck className="size-4 text-muted-foreground" />
              <input inputMode="numeric" pattern="[0-9 ]*" maxLength={7} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} autoComplete="one-time-code" className={cn(input, 'tracking-widest')} placeholder="123 456" />
            </div>
          </label>
        )}

        <Btn type="submit" variant="accent" busy={busy} className="mt-2 h-10 w-full justify-center">
          <LogIn className="size-4" /> {t('login.submit')}
        </Btn>
        {ver && <p className="mt-5 text-center text-xs text-muted-foreground/70">{t('login.version', { v: ver })}</p>}
      </form>
    </div>
  )
}
