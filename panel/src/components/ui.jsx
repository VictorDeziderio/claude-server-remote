import { useEffect } from 'react'
import { Loader2, Check, X } from 'lucide-react'

export function Dot({ on, pulse }) {
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${on ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,.5)]' : 'bg-rose-500'} ${pulse ? 'animate-pulse' : ''}`} />
}

export function Btn({ onClick, busy, children, variant = 'default', title, className = '', type = 'button', disabled }) {
  const cls = {
    default: 'bg-ink-500 hover:bg-ink-500/70 text-slate-100',
    accent: 'bg-claude/90 hover:bg-claude text-white',
    ghost: 'bg-transparent hover:bg-white/5 text-slate-300 ring-1 ring-white/10',
    danger: 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 ring-1 ring-rose-500/25',
    sky: 'bg-sky-500/90 hover:bg-sky-500 text-white',
  }[variant]
  return (
    <button type={type} onClick={onClick} disabled={busy || disabled} title={title}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition disabled:opacity-50 ${cls} ${className}`}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  )
}

export function IconBtn({ onClick, title, children, active, className = '' }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className={`rounded-lg p-2 ring-1 ring-white/5 transition hover:text-white ${active ? 'bg-claude/20 text-claude' : 'bg-ink-700/60 text-slate-300 hover:bg-ink-500'} ${className}`}>
      {children}
    </button>
  )
}

export function Chip({ on, onClick, busy, labelOn, labelOff, Icon }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} title="clique para alternar"
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
        on ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30' : 'bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/25'}`}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {on ? labelOn : labelOff}
    </button>
  )
}

export function Modal({ title, icon: Icon, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-2xl bg-ink-800 p-5 shadow-2xl shadow-black/40 ring-1 ring-white/10`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">{Icon && <Icon className="h-4 w-4 text-claude" />} {title}</div>
          <button type="button" onClick={onClose} aria-label="fechar" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Toast({ flash, onClose }) {
  useEffect(() => {
    if (!flash) return undefined
    const t = setTimeout(onClose, flash.ok ? 5000 : 8000)
    return () => clearTimeout(t)
  }, [flash, onClose])
  if (!flash) return null
  return (
    <div className={`pointer-events-auto fixed bottom-4 left-1/2 z-[60] flex w-[min(92vw,40rem)] -translate-x-1/2 items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-2xl shadow-black/40 ring-1 ${
      flash.ok ? 'bg-emerald-950/90 text-emerald-100 ring-emerald-500/30' : 'bg-rose-950/90 text-rose-100 ring-rose-500/30'}`} role="status">
      {flash.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <X className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{flash.msg}</span>
      <button type="button" onClick={onClose} aria-label="fechar" className="rounded p-0.5 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
    </div>
  )
}

export function Card({ title, subtitle, children, className = '' }) {
  return (
    <section className={`rounded-2xl bg-ink-800 p-4 ring-1 ring-white/5 ${className}`}>
      {(title || subtitle) && (
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
          {subtitle && <span className="text-xs text-slate-500">{subtitle}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

export const Empty = ({ children = 'sem dados' }) => <div className="py-8 text-center text-sm text-slate-500">{children}</div>

export const inputCls = 'rounded-lg bg-ink-900 px-2.5 py-1.5 text-sm text-slate-200 ring-1 ring-white/10 placeholder:text-slate-600 focus:outline-none focus:ring-claude/40'
