import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Check, X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Button } from './ui/button.jsx'
import { Card as SCard, CardHeader, CardTitle, CardContent, CardAction } from './ui/card.jsx'
import { Badge } from './ui/badge.jsx'
import { Skeleton as SSkeleton } from './ui/skeleton.jsx'
import { cn } from '../lib/utils.js'
import { t } from '../lib/i18n.js'

export function Dot({ on, pulse, color }) {
  const c = color || (on ? 'bg-success' : 'bg-destructive')
  return <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', c, pulse && 'animate-pulse')} />
}

// estado de atividade do Claude numa sessao (watcher do servidor). Uma unica cor de destaque
// (primary/ambar) e reservada pra "trabalhando"; os outros 3 estados usam as cores semanticas
// do tema (success/destructive/muted) em vez de inventar um 5o acento.
export const ACTIVITY = {
  busy: { get label() { return t('activity.busy') }, cls: 'bg-warning', text: 'text-warning', pulse: true },
  prompt: { get label() { return t('activity.prompt') }, cls: 'bg-destructive', text: 'text-destructive', pulse: true },
  idle: { get label() { return t('activity.idle') }, cls: 'bg-success', text: 'text-success', pulse: false },
  off: { get label() { return t('activity.off') }, cls: 'bg-muted-foreground/40', text: 'text-muted-foreground', pulse: false },
}
export function ActivityDot({ state }) {
  const a = ACTIVITY[state] || ACTIVITY.off
  return <Dot color={a.cls} pulse={a.pulse} />
}
export function ActivityBadge({ state, since }) {
  const a = ACTIVITY[state] || ACTIVITY.off
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-normal', a.text)} title={since ? t('activity.since', { time: new Date(since).toLocaleTimeString() }) : ''}>
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
    <button type="button" onClick={onClick} disabled={busy} title={t('chip.toggle')}
      className={cn(
        'group/badge inline-flex h-9 shrink-0 items-center gap-1.5 rounded-4xl border px-3 py-0.5 text-xs font-medium transition-all disabled:pointer-events-none disabled:opacity-50 sm:h-5 sm:px-2', // alvo de toque maior no celular
        on ? 'border-transparent bg-success/15 text-success' : 'border-transparent bg-destructive/10 text-destructive'
      )}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
      {on ? labelOn : labelOff}
    </button>
  )
}

// ---- Modal (centered) and Drawer (side panel): ONE overlay system, built on the Radix Dialog of
// shadcn (components/ui/dialog.jsx uses the same primitive). Radix gives what the hand-made version
// lacked: portal to <body> (no parent with overflow/transform can clip it), focus trapped inside and
// returned to the button that opened it, background scroll locked, Escape closes only the TOP one,
// and an outside click counts only when the press STARTS outside (selecting text in a field and
// releasing the mouse on the backdrop no longer closes it).
// Layers (keep in this order): fullscreen terminal 60 · terminal text view 70 · MODALS 80 · toast 90.
// Before, the modal was z-50 and the "Paste" box opened BEHIND the fullscreen terminal.
// dismissible=false: only the X button closes it (a click outside or Escape would lose a flow
// in progress, e.g. the Claude login).
export const OVERLAY_Z = 'z-[80]'
function Overlay({ title, icon: Icon, onClose, dismissible = true, side, wide, children }) {
  const guard = dismissible ? undefined : (e) => e.preventDefault()
  // focus back to whatever opened it (Radix only does this for its own <Dialog.Trigger>, which
  // these callers do not use: without this the focus fell to <body>)
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  useEffect(() => () => { const el = opener.current; setTimeout(() => { if (el?.isConnected) el.focus?.() }, 0) }, [])
  const head = (
    <div className={cn('flex items-center justify-between gap-2', side ? 'border-b p-4' : 'mb-4')}>
      <DialogPrimitive.Title className="flex min-w-0 items-center gap-2 text-base font-medium">
        {Icon && <Icon className="size-4 shrink-0 text-primary" />} <span className="truncate">{title}</span>
      </DialogPrimitive.Title>
      <DialogPrimitive.Close aria-label={t('common.close')} className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"><X className="size-4" /></DialogPrimitive.Close>
    </div>
  )
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose?.() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="modal-overlay" className={cn('fixed inset-0 bg-black/40', OVERLAY_Z)} />
        <DialogPrimitive.Content
          data-slot={side ? 'drawer' : 'modal'}
          aria-describedby={undefined}
          onPointerDownOutside={guard} onEscapeKeyDown={guard} onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn('fixed flex flex-col bg-popover text-popover-foreground outline-none', OVERLAY_Z,
            side
              ? 'inset-y-0 right-0 h-full w-full max-w-lg animate-fade-in border-l pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
              : cn('inset-x-0 top-1/2 mx-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-y-1/2 overflow-auto overscroll-contain rounded-xl border border-border p-4 animate-fade-in', wide ? 'max-w-3xl' : 'max-w-sm'))}>
          {head}
          {side ? <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-4">{children}</div> : children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
export const Modal = (props) => <Overlay {...props} />
// side panel on the right — used for "configure project"
export const Drawer = (props) => <Overlay {...props} side />

// Confirmation in the panel's own modal (window.confirm is blocked or looks foreign in the
// installed phone app). const [confirmEl, ask] = useConfirm(); ... if (await ask(text)) ...; render {confirmEl}
export function useConfirm() {
  const [q, setQ] = useState(null) // { text, title, danger, resolve }
  const ask = useCallback((text, opts = {}) => new Promise((resolve) => setQ({ text, ...opts, resolve })), [])
  const answer = (v) => { q?.resolve(v); setQ(null) }
  const el = q && (
    <Modal title={q.title || t('common.confirm')} icon={q.icon} onClose={() => answer(false)}>
      <p className="text-sm text-muted-foreground">{q.text}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={() => answer(false)}>{t('common.cancel')}</Btn>
        <Btn variant={q.danger ? 'danger' : 'accent'} onClick={() => answer(true)}>{q.yes || t('common.yes')}</Btn>
      </div>
    </Modal>
  )
  return [el, ask]
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
    <div className={cn('pointer-events-auto fixed z-[90] flex animate-fade-up items-start gap-2 rounded-lg border px-4 py-3 text-sm', pos,
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

export const Empty = ({ children = t('common.noData') }) => <div className="py-8 text-center text-sm text-muted-foreground">{children}</div>

export const Skeleton = SSkeleton

// confirmacao inline (substitui window.confirm): "Excluir X? [Sim] [Nao]"
export function InlineConfirm({ text, onYes, onNo, busy, danger = true }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-foreground">
      <span>{text}</span>
      <Btn size="sm" variant={danger ? 'danger' : 'accent'} busy={busy} onClick={onYes}>{t('common.yes')}</Btn>
      <Btn size="sm" variant="ghost" onClick={onNo}>{t('common.no')}</Btn>
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
