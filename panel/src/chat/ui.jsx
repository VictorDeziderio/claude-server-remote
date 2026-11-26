// Shared building blocks of the chat screens: header, icon button, toasts, spinner, sentinel.
import React, { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

export const cx = (...a) => a.filter(Boolean).join(' ')

// 44px tap target (Apple HIG), icon centered. Variants keep colors from fighting each other.
const VARIANTS = {
  ghost: 'text-foreground hover:bg-accent active:bg-accent',
  muted: 'text-muted-foreground hover:bg-accent active:bg-accent',
  brand: 'bg-brand text-white hover:bg-brand/90 active:bg-brand/80 disabled:bg-muted disabled:text-muted-foreground',
  solid: 'bg-foreground text-background hover:bg-foreground/85 active:bg-foreground/75',
  dark: 'text-white hover:bg-white/10 active:bg-white/15',
}
export function IconButton({ label, variant = 'ghost', className, children, ...rest }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx('inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-default', VARIANTS[variant], variant !== 'brand' && 'disabled:opacity-40', className)} {...rest}>
      {children}
    </button>
  )
}

// Top bar. chat-top adds the status-bar safe area (notch / status bar of the home-screen app).
export function Header({ left, right, children, testid }) {
  return (
    <header data-testid={testid} className="chat-top relative z-10 shrink-0 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="flex h-14 items-center gap-1 px-1.5">
        {left}
        <div className="min-w-0 flex-1">{children}</div>
        {right}
      </div>
    </header>
  )
}

export const Spinner = ({ className }) => <Loader2 aria-hidden className={cx('size-5 animate-spin text-muted-foreground', className)} />

// Calls onHit when it scrolls into view (infinite scroll). `root` is the scrolling element.
export function Sentinel({ onHit, enabled, rootRef, margin = '300px', testid }) {
  const ref = useRef(null)
  const cb = useRef(onHit)
  cb.current = onHit
  useEffect(() => {
    if (!enabled || !ref.current || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) cb.current() }, { root: rootRef?.current || null, rootMargin: margin })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [enabled, rootRef, margin])
  return <div ref={ref} data-testid={testid} aria-hidden className="h-px w-full" />
}

// Toasts: toast('text') from anywhere; <Toasts/> renders them above the composer. Absolute inside the
// app box (.chat-app, which follows the visible area above the iOS keyboard), not fixed to the
// layout viewport: fixed, they sat behind the keyboard.
const TOAST = 'chat-toast'
export const toast = (msg) => { try { window.dispatchEvent(new CustomEvent(TOAST, { detail: String(msg) })) } catch { /* no DOM */ } }
export function Toasts() {
  const [list, setList] = useState([])
  useEffect(() => {
    let n = 0
    const on = (e) => {
      const id = ++n
      setList((l) => [...l.slice(-2), { id, msg: e.detail }])
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 3500)
    }
    window.addEventListener(TOAST, on)
    return () => window.removeEventListener(TOAST, on)
  }, [])
  if (!list.length) return null
  return (
    <div role="status" aria-live="polite" data-testid="toasts" className="pointer-events-none absolute inset-x-0 bottom-28 z-50 flex flex-col items-center gap-2 px-4">
      {list.map((x) => <div key={x.id} data-testid="toast" className="max-w-sm rounded-full bg-foreground px-4 py-2 text-center text-sm text-background shadow-lg animate-fade-up">{x.msg}</div>)}
    </div>
  )
}
