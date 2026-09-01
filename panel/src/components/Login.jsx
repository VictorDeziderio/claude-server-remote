import { useState } from 'react'
import { LogIn, Lock, User, Loader2, AlertCircle } from 'lucide-react'
import Logo from './Logo.jsx'
import { login } from '../api.js'

export default function Login({ onSuccess }) {
  const [form, setForm] = useState({ login: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = await login(form.login.trim(), form.password)
      if (r.ok) onSuccess()
      else setErr(r.msg || 'login ou senha incorretos')
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto px-4 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-3xl bg-ink-800 p-7 ring-1 ring-white/5 shadow-2xl shadow-black/40"
      >
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-claude/30">
            <Logo size={32} />
          </div>
          <h1 className="text-xl font-semibold text-white">
            Claude <span className="text-claude">Remote</span>
          </h1>
          <p className="mt-1 text-xs text-slate-400">entre para acessar o painel</p>
        </div>

        {err && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-rose-500/10 px-3 py-2 text-sm text-rose-200 ring-1 ring-rose-500/25">
            <AlertCircle className="h-4 w-4" /> {err}
          </div>
        )}

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-slate-400">Login</span>
          <div className="flex items-center gap-2 rounded-xl bg-ink-900 px-3 ring-1 ring-white/10 focus-within:ring-claude/40">
            <User className="h-4 w-4 text-slate-500" />
            <input
              value={form.login}
              onChange={(e) => setForm((f) => ({ ...f, login: e.target.value }))}
              autoFocus
              autoComplete="username"
              className="w-full bg-transparent py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
              placeholder="admin"
            />
          </div>
        </label>

        <label className="mb-5 block">
          <span className="mb-1 block text-xs text-slate-400">Senha</span>
          <div className="flex items-center gap-2 rounded-xl bg-ink-900 px-3 ring-1 ring-white/10 focus-within:ring-claude/40">
            <Lock className="h-4 w-4 text-slate-500" />
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              autoComplete="current-password"
              className="w-full bg-transparent py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
              placeholder="••••••••"
            />
          </div>
        </label>

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-claude/90 py-2.5 text-sm font-semibold text-white transition hover:bg-claude disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          Entrar
        </button>

      </form>
    </div>
  )
}
