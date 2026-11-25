import { useEffect, useState } from 'react'
import { Loader2, Check, X } from 'lucide-react'
import { Button } from './ui/button.jsx'
import { Card as SCard, CardHeader, CardTitle, CardContent, CardAction } from './ui/card.jsx'
import { Badge } from './ui/badge.jsx'
import { Skeleton as SSkeleton } from './ui/skeleton.jsx'
import { cn } from '../lib/utils.js'

export function Dot({ on, pulse, color }) {
  const c = color || (on ? 'bg-success' : 'bg-destructive')
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', c, pulse && 'animate-pulse')} />
}

// estado de atividade do Claude numa sessao (watcher do servidor). Uma unica cor de destaque
// (primary/ambar) e reservada pra "trabalhando"; os outros 3 estados usam as cores semanticas
// do tema (success/destructive/muted) em vez de inventar um 5o acento.
export const ACTIVITY = {
  busy: { label: 'trabalhando', cls: 'bg-primary', text: 'text-primary', pulse: true },
  prompt: { label: 'aguardando você', cls: 'bg-destructive', text: 'text-destructive', pulse: true },
  idle: { label: 'ocioso', cls: 'bg-success', text: 'text-success', pulse: false },
  off: { label: 'parado', cls: 'bg-muted-foreground/40', text: 'text-muted-foreground', pulse: false },
}
export function ActivityDot({ state }) {
  const a = ACTIVITY[state] || ACTIVITY.off
  return <Dot color={a.cls} pulse={a.pulse} />
}
export function ActivityBadge({ state, since }) {
  const a = ACTIVITY[state] || ACTIVITY.off
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-normal', a.text)} title={since ? 'desde ' + new Date(since).toLocaleTimeString() : ''}>
      <Dot color={a.cls} pulse={a.pulse} /> {a.label}
    </Badge>
  )
}

// mapeia a API antiga (default/accent/ghost/danger/sky) pras variantes do Button do shadcn.
// "accent" = a acao primaria (ambar) = variant "default" do shadcn (que ja e' bg-primary).
const VARIANT_MAP = { default: 'secondary', accent: 'default', ghost: 'ghost', danger: 'destructive', sky: 'secondary' }
export function Btn({ onClick, busy, children, variant = 'default', title, className = '', type = 'button', disabled, size }) {
  return (
    <Button type={type} onClick={onClick} disabled={busy || disabled} title={title}
      variant={VARIANT_MAP[variant] || 'secondary'} size={size === 'sm' ? 'sm' : 'default'}
      className={cn('gap-1.5', className)}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : children}
    </Button>
  )
}

export function IconBtn({ onClick, title, children, active, className = '', disabled }) {
  return (
    <Button type="button" onClick={onClick} title={title} aria-label={title} disabled={disabled}
      variant={active ? 'default' : 'secondary'} size="icon"
      className={className}>
      {children}
    </Button>
  )
}

// toggle on/off (Power/Claude/Remote nos cards de projeto) -- Badge clicavel, nao um Button:
// e' um ESTADO que se le, nao uma acao que se dispara.
export function Chip({ on, onClick, busy, labelOn, labelOff, Icon }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} title="clique para alternar"
      className={cn(
        'group/badge inline-flex h-9 shrink-0 items-center gap-1.5 rounded-4xl border px-3 py-0.5 text-xs font-medium transition-all disabled:pointer-events-none disabled:opacity-50 sm:h-5 sm:px-2', // alvo de toque maior no celular
        on ? 'border-transparent bg-success/15 text-success' : 'border-transparent bg-destructive/10 text-destructive'
      )}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className={cn('max-h-[92vh] w-full animate-fade-up overflow-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground', wide ? 'max-w-3xl' : 'max-w-sm')}
        onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-base font-medium">{Icon && <Icon className="size-4 text-primary" />} {title}</div>
          <button type="button" onClick={onClose} aria-label="fechar" className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-full max-w-lg animate-fade-up flex-col border-l bg-popover text-popover-foreground" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b p-4">
          <div className="flex items-center gap-2 text-base font-medium">{Icon && <Icon className="size-4 text-primary" />} {title}</div>
          <button type="button" onClick={onClose} aria-label="fechar" className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"><X className="size-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
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
  // centralizado com inset-x + mx-auto (e nao left-1/2 + -translate-x-1/2): a animacao fade-up
  // mexe no transform e anulava o translate -> o aviso saia metade fora da tela no celular.
  // No celular fica acima da navegacao de baixo.
  const pos = position === 'top-right'
    ? 'top-[calc(env(safe-area-inset-top)+1rem)] inset-x-0 mx-auto w-[min(92vw,26rem)] sm:left-auto sm:right-4 sm:mx-0'
    : 'bottom-[calc(env(safe-area-inset-bottom)+5rem)] inset-x-0 mx-auto w-[min(92vw,40rem)] sm:bottom-4'
  return (
    <div className={cn('pointer-events-auto fixed z-[70] flex animate-fade-up items-start gap-2 rounded-lg border px-4 py-3 text-sm', pos,
      flash.ok ? 'border-success/30 bg-success/10 text-success' : 'border-destructive/30 bg-destructive/10 text-destructive')} role="status">
      {flash.ok ? <Check className="mt-0.5 size-4 shrink-0" /> : <X className="mt-0.5 size-4 shrink-0" />}
      <span className="min-w-0 flex-1 break-words text-foreground">{flash.msg}</span>
      <button type="button" onClick={onClose} aria-label="fechar" className="rounded p-0.5 opacity-70 hover:opacity-100"><X className="size-3.5" /></button>
    </div>
  )
}

// wrapper fino sobre o Card do shadcn preservando a API antiga (title/subtitle/actions como
// props) pra nenhuma pagina precisar recompor CardHeader/CardContent manualmente.
export function Card({ title, subtitle, children, className = '', actions }) {
  return (
    // sobrescreve o ring padrao do shadcn (ring-foreground/10 -- quase invisivel no tema escuro
    // atual: baixo contraste entre o ring e o bg-card) pela cor de borda real do tema
    <SCard className={cn('ring-border', className)}>
      {(title || subtitle || actions) && (
        <CardHeader>
          <CardTitle className={subtitle ? 'self-center' : ''}>{title}</CardTitle>
          {subtitle && <CardAction className="col-start-2 row-start-1 row-span-1 self-center text-xs text-muted-foreground">{subtitle}</CardAction>}
          {actions && <CardAction className={subtitle ? 'row-start-2' : ''}>{actions}</CardAction>}
        </CardHeader>
      )}
      <CardContent>{children}</CardContent>
    </SCard>
  )
}

export const Empty = ({ children = 'sem dados' }) => <div className="py-8 text-center text-sm text-muted-foreground">{children}</div>

export const Skeleton = SSkeleton

// confirmacao inline (substitui window.confirm): "Excluir X? [Sim] [Nao]"
export function InlineConfirm({ text, onYes, onNo, busy, danger = true }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-foreground">
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
    <form className={cn('inline-flex items-center gap-1.5', className)} onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()) }}>
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel?.() }}
        className={cn(inputCls, 'w-48 py-1')} />
      <Btn size="sm" variant="accent" type="submit" busy={busy} disabled={!v.trim()}><Check className="size-3.5" /></Btn>
      <Btn size="sm" variant="ghost" onClick={onCancel}><X className="size-3.5" /></Btn>
    </form>
  )
}

export const inputCls = 'rounded-md border border-input bg-input/20 px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 transition'
