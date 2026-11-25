import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Gauge, RefreshCw, AlertTriangle, LogIn } from 'lucide-react'
import { Card, Btn } from './ui.jsx'
import { fmtAgo } from '../lib/format.js'
import { cn } from '../lib/utils.js'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'

// Plan limits (Claude subscription 5h/weekly windows) + Anthropic API spend, from the server's
// poller (server/limits.js). GET /api/limits only reads the server cache, so polling it every
// minute while the tab is visible costs nothing upstream.
export function useLimits() {
  const [snap, setSnap] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api.limits().then((r) => { if (r && r.claude) setSnap(r) }).catch(() => {}), [])
  useEffect(() => {
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, 60000)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [load])
  const refresh = useCallback(async () => {
    setBusy(true)
    try { const r = await api.limitsRefresh(); if (r && r.claude) setSnap(r) } catch { /* */ }
    setBusy(false)
  }, [])
  return { snap, busy, refresh }
}

// "in 2h 14m" / "Sun 02:00" — short enough for a phone row
export function fmtReset(isoStr) {
  if (!isoStr) return ''
  const ts = new Date(isoStr).getTime()
  const s = Math.round((ts - Date.now()) / 1000)
  if (!Number.isFinite(s)) return ''
  if (s <= 0) return t('usage.resettingNow')
  if (s < 3600) return t('usage.resetsInM', { m: Math.max(1, Math.round(s / 60)) })
  if (s < 86400) return t('usage.resetsInHM', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) })
  const d = new Date(ts)
  return 'resets ' + d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

const barColor = (p, th) => {
  const [warn = 80, crit = 95] = th || []
  return p >= crit ? 'bg-destructive' : p >= warn ? 'bg-amber-500' : 'bg-success'
}

export function LimitBar({ label, percent, resetsAt, thresholds, stale }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0))
  return (
    <div className={cn('min-w-0', stale && 'opacity-60')}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-foreground/80">{label}</span>
        <span className="shrink-0 font-mono text-foreground">{Math.round(p)}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn('h-full rounded-full transition-all', barColor(p, thresholds))} style={{ width: `${p}%` }} />
      </div>
      {resetsAt && <div className="mt-0.5 text-[11px] text-muted-foreground" title={new Date(resetsAt).toLocaleString()}>{fmtReset(resetsAt)}</div>}
    </div>
  )
}

const money = (v, cur = 'USD') => (v === null || v === undefined ? '—' : (cur === 'USD' ? 'US$ ' : cur + ' ') + Number(v).toFixed(2))

function ClaudeStatus({ c, compact }) {
  if (c.status === 'ok' || c.status === 'pending') return null
  const reconnect = c.status === 'auth_error' || c.status === 'expired' || c.status === 'not_logged_in'
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-200">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className={cn('min-w-0', compact && 'truncate')}>{c.message}</span>
      {reconnect && <Link to="/account?login=1" className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><LogIn className="h-3 w-3" /> {t('usage.reconnect')}</Link>}
    </div>
  )
}

// compact widget for the projects page: main windows only, one row per bar (good on a phone)
export function UsageWidget() {
  const { snap } = useLimits()
  if (!snap || snap.enabled === false) return null
  const c = snap.claude || {}
  const a = snap.api || {}
  const wins = (c.windows || []).slice(0, 3)
  // nothing to show yet / no subscription login (the summary above already says "logged out")
  if (!wins.length && (c.status === 'pending' || c.status === 'not_logged_in') && !a.configured) return null
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <Link to="/account#usage" className="inline-flex items-center gap-1.5 hover:underline"><Gauge className="h-3.5 w-3.5" /> {t('usage.plan')}{c.plan ? ` · ${c.plan}` : ''}</Link>
        {c.fetchedAt ? <span>{fmtAgo(c.fetchedAt)}</span> : null}
      </div>
      <ClaudeStatus c={c} compact />
      {wins.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {wins.map((w) => <LimitBar key={w.id} {...w} thresholds={snap.thresholds} stale={c.stale} />)}
        </div>
      )}
      {a.configured && a.status === 'ok' && (
        <div className="text-xs text-foreground/80">
          <span className="font-mono">{t('usage.apiSpendLine', { today: money(a.today, a.currency), month: money(a.month, a.currency) })}</span>
          {a.budget ? <span className="text-muted-foreground"> {t('usage.ofBudget', { pct: Math.round(a.percent || 0), budget: money(a.budget, a.currency) })}</span> : null}
        </div>
      )}
    </div>
  )
}

// full card for the Account page
export function UsageDetails() {
  const { snap, busy, refresh } = useLimits()
  const c = (snap && snap.claude) || {}
  const a = (snap && snap.api) || {}
  return (
    <div id="usage">
      <Card title={t('usage.title')} subtitle={snap && snap.updatedAt ? t('usage.updated', { ago: fmtAgo(snap.updatedAt) }) : ''}
        actions={<Btn size="sm" onClick={refresh} busy={busy} title={t('usage.checkNow')}><RefreshCw className="h-3.5 w-3.5" /> {t('common.refresh')}</Btn>}>
        {!snap ? <div className="text-sm text-muted-foreground">{t('common.loading')}</div> : snap.enabled === false ? (
          <div className="text-sm text-muted-foreground">{t('usage.disabled')}</div>
        ) : (
          <div className="space-y-5">
            <section className="space-y-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('usage.subscription')}{c.plan ? ` (${c.plan})` : ''}</h3>
              <ClaudeStatus c={c} />
              {(c.windows || []).length > 0 && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {c.windows.map((w) => <LimitBar key={w.id} {...w} thresholds={snap.thresholds} stale={c.stale} />)}
                </div>
              )}
              {c.extra && (
                <div className="text-xs text-foreground/80">
                  <span className="font-mono">{t('usage.extra', { used: money(c.extra.used, c.extra.currency), limit: money(c.extra.limit, c.extra.currency) })}</span>
                  {c.extra.percent !== null ? ` (${Math.round(c.extra.percent)}%)` : ''}
                </div>
              )}
              {c.status === 'ok' && !(c.windows || []).length && <div className="text-xs text-muted-foreground">{c.message}</div>}
            </section>
            <section className="space-y-2 border-t border-border pt-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('usage.api')}</h3>
              {!a.configured ? (
                <div className="text-xs text-muted-foreground">{t('usage.apiNotConfigured')}</div>
              ) : (
                <>
                  {a.status !== 'ok' && a.message && <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-200"><AlertTriangle className="h-3.5 w-3.5" /> {a.message}</div>}
                  <div className="grid grid-cols-2 gap-3">
                    <div><div className="text-[11px] text-muted-foreground">{t('usage.todayUtc')}</div><div className="font-mono text-sm text-foreground">{money(a.today, a.currency)}</div></div>
                    <div><div className="text-[11px] text-muted-foreground">{t('usage.thisMonth')}</div><div className="font-mono text-sm text-foreground">{money(a.month, a.currency)}</div></div>
                  </div>
                  {a.budget ? <LimitBar label={t('usage.budget', { v: money(a.budget, a.currency) })} percent={a.percent} thresholds={snap.thresholds} stale={a.stale} /> : null}
                  <div className="text-[11px] text-muted-foreground">{a.note}</div>
                </>
              )}
            </section>
            <div className="text-[11px] text-muted-foreground">
              {t('usage.footer', { min: Math.round((snap.intervalSec || 300) / 60), th: (snap.thresholds || []).join('% / ') })}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
