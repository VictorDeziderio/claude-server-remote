import { useEffect, useState } from 'react'
import { Loader2, Check, X } from 'lucide-react'

export function Dot({ on, pulse, color }) {
  const c = color || (on ? 'bg-live-400 shadow-[0_0_8px_2px_rgba(79,224,203,.45)]' : 'bg-rose-500')
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${c} ${pulse ? 'animate-pulse' : ''}`} />
}

// estado de atividade do Claude numa sessao (watcher do servidor)
// idle deixa de ser emerald -> vira "live" (ciano): emerald fica reservado p/ confirmacao de
// acao bem-sucedida (toast, 2FA ativo). busy/prompt continuam amber/rose, pulsantes.
export const ACTIVITY = {
  busy: { label: 'trabalhando', cls: 'bg-amber-400 shadow-[0_0_8px_2px_rgba(251,191,36,.45)]', text: 'text-amber-300', pulse: true },
  prompt: { label: 'aguardando você', cls: 'bg-rose-400 shadow-[0_0_8px_2px_rgba(251,113,133,.5)]', text: 'text-rose-300', pulse: true },
  idle: { label: 'ocioso', cls: 'bg-live-400 shadow-[0_0_8px_2px_rgba(79,224,203,.45)]', text: 'text-live-300', pulse: false },
  off: { label: 'parado', cls: 'bg-ink-500', text: 'text-slate-500', pulse: false },
}
export function ActivityDot({ state }) {
  const a = ACTIVITY[state] || ACTIVITY.off
  return <Dot color={a.cls} pulse={a.pulse} />
}
export function ActivityBadge({ state, since }) {
  const a = ACTIVITY[state] || ACTIVITY.off
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-mono-sm font-medium ring-1 ring-white/6 ${a.text} bg-white/[.03]`} title={since ? 'desde ' + new Date(since).toLocaleTimeString() : ''}>
      <Dot color={a.cls} pulse={a.pulse} /> {a.label}
    </span>
  )
}

export function Btn({ onClick, busy, children, variant = 'default', title, className = '', type = 'button', disabled, size }) {
  const cls = {
    default: 'bg-ink-500 hover:bg-ink-600 text-slate-100',
    accent: 'bg-claude hover:bg-claude-600 hover:shadow-glow-accent text-white',
    ghost: 'bg-transparent hover:bg-white/5 text-slate-300 ring-1 ring-white/10',
    danger: 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 ring-1 ring-rose-500/25',
    sky: 'bg-sky-500/90 hover:bg-sky-500 text-white',
  }[variant]
  const sz = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-[13px]'
  return (
    <button type={type} onClick={onClick} disabled={busy || disabled} title={title}
      className={`inline-flex items-center gap-1.5 rounded-lg font-medium transition duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-claude/60 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-900 disabled:opacity-40 ${sz} ${cls} ${className}`}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  )
}

export function IconBtn({ onClick, title, children, active, className = '', disabled }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} disabled={disabled}
      className={`rounded-lg p-2 ring-1 ring-white/6 transition duration-150 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-claude/60 disabled:opacity-40 ${active ? 'bg-claude/20 text-claude' : 'bg-ink-700/60 text-slate-300 hover:bg-ink-600'} ${className}`}>
      {children}
    </button>
  )
}

export function Chip({ on, onClick, busy, labelOn, labelOff, Icon }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} title="clique para alternar"
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-mono-sm font-medium transition duration-150 hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-claude/60 disabled:opacity-40 disabled:hover:scale-100 ${
        on ? 'bg-live-500/15 text-live-300 ring-1 ring-live-500/30' : 'bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/25'}`}>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className={`max-h-[92vh] w-full animate-fade-up overflow-auto ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-2xl bg-ink-800 p-5 shadow-elevated ring-1 ring-white/8`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-heading text-white">{Icon && <Icon className="h-4 w-4 text-claude" />} {title}</div>
          <button type="button" onClick={onClose} aria-label="fechar" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

// painel lateral (drawer) a direita — usado p/ "configurar projeto"
export function Drawer({ title, icon: Icon, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside className="flex h-full w-full max-w-lg animate-fade-up flex-col bg-ink-800 shadow-elevated ring-1 ring-white/8" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b border-white/6 px-5 py-4">
          <div className="flex items-center gap-2 text-heading text-white">{Icon && <Icon className="h-4 w-4 text-claude" />} {title}</div>
          <button type="button" onClick={onClose} aria-label="fechar" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
      </aside>
    </div>
  )
}

export function Toast({ flash, onClose, position = 'bottom' }) {
  useEffect(() => {
    if (!flash) return undefined
    const t = setTimeout(onClose, flash.ok ? 5000 : 8000)
    return () => clearTimeout(t)
  }, [flash, onClose])
  if (!flash) return null
  const pos = position === 'top-right' ? 'top-4 right-4 w-[min(92vw,26rem)]' : 'bottom-4 left-1/2 -translate-x-1/2 w-[min(92vw,40rem)]'
  return (
    <div className={`pointer-events-auto fixed z-[70] flex animate-fade-up items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-elevated ring-1 ${pos} ${
      flash.ok ? 'bg-emerald-950/95 text-emerald-100 ring-emerald-500/30' : 'bg-rose-950/95 text-rose-100 ring-rose-500/30'}`} role="status">
      {flash.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <X className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1 break-words">{flash.msg}</span>
      <button type="button" onClick={onClose} aria-label="fechar" className="rounded p-0.5 opacity-70 hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
    </div>
  )
}

export function Card({ title, subtitle, children, className = '', actions }) {
  return (
    <section className={`rounded-2xl bg-ink-800 p-5 shadow-card ring-1 ring-white/6 ${className}`}>
      {(title || subtitle || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-heading text-slate-200">{title}</h3>
          <div className="flex items-center gap-2">{subtitle && <span className="text-small text-slate-500">{subtitle}</span>}{actions}</div>
        </div>
      )}
      {children}
    </section>
  )
}

export const Empty = ({ children = 'sem dados' }) => <div className="py-8 text-center text-sm text-slate-500">{children}</div>

export const Skeleton = ({ className = '' }) => <div className={`animate-pulse rounded-lg bg-white/5 ${className}`} />

// confirmacao inline (substitui window.confirm): "Excluir X? [Sim] [Nao]"
export function InlineConfirm({ text, onYes, onNo, busy, danger = true }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-slate-300">
      <span>{text}</span>
      <Btn size="sm" variant={danger ? 'danger' : 'accent'} busy={busy} onClick={onYes}>Sim</Btn>
      <Btn size="sm" variant="ghost" onClick={onNo}>Não</Btn>
    </span>
  )
}

// input inline com Enter/Esc (substitui window.prompt)
export function InlineInput({ initial = '', placeholder, onSubmit, onCancel, busy, className = '' }) {
  const [v, setV] = useState(initial)
  return (
    <form className={`inline-flex items-center gap-1.5 ${className}`} onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()) }}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel?.() }}
        className={`${inputCls} w-48 py-1`} />
      <Btn size="sm" variant="accent" type="submit" busy={busy} disabled={!v.trim()}><Check className="h-3.5 w-3.5" /></Btn>
      <Btn size="sm" variant="ghost" onClick={onCancel}><X className="h-3.5 w-3.5" /></Btn>
    </form>
  )
}

export const inputCls = 'rounded-lg bg-ink-900 px-2.5 py-1.5 text-sm text-slate-200 ring-1 ring-white/10 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-claude/50 transition'
