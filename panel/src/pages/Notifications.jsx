import { useCallback, useEffect, useState } from 'react'
import { BellRing, BellOff, Send, Trash2, Smartphone, Download, Share, PlusSquare, MoreVertical, CheckCircle2, AlertTriangle, RefreshCw, Webhook } from 'lucide-react'
import { Btn, Card, Empty, Skeleton } from '../components/ui.jsx'
import { cn } from '../lib/utils.js'
import * as P from '../lib/push.js'

const fmtAgo = (ms) => {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}

// /notifications — install the panel as an app (PWA) and get Web Push on the phone:
// this device on/off, registered devices, per-event toggles, recent notifications.

function Toggle({ on, onChange, label, busy }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={() => onChange(!on)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50', on ? 'bg-primary' : 'bg-input')}>
      <span className={cn('inline-block size-5 rounded-full bg-background shadow transition-transform', on ? 'translate-x-[22px]' : 'translate-x-0.5')} />
    </button>
  )
}

function Pill({ ok, children }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs', ok ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>
      {ok ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />} {children}
    </span>
  )
}

function Step({ n, children }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-medium text-primary">{n}</span>
      <span className="pt-0.5 text-sm text-foreground/90">{children}</span>
    </li>
  )
}

function InstallGuide({ installEvt, onInstall }) {
  const ios = P.isIOS(), android = P.isAndroid()
  const [tab, setTab] = useState(ios ? 'ios' : 'android')
  return (
    <Card title="Install on your phone" subtitle={P.isStandalone() ? 'running as an installed app' : ''}>
      <div className="space-y-4">
        {installEvt && (
          <Btn variant="accent" onClick={onInstall} className="w-full sm:w-auto"><Download className="size-4" /> Install app</Btn>
        )}
        <div className="flex gap-1.5">
          {[['ios', 'iPhone / iPad'], ['android', 'Android']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={cn('rounded-md px-3 py-1.5 text-sm', tab === k ? 'bg-accent text-primary' : 'bg-card text-muted-foreground ring-1 ring-border')}>{l}</button>
          ))}
        </div>
        {tab === 'ios' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              On iPhone and iPad, Web Push only works in the <b className="text-foreground">installed app</b> (iOS/iPadOS 16.4 or newer), not in a Safari tab.
            </p>
            <ol className="space-y-2.5">
              <Step n={1}>Open this panel in <b>Safari</b>.</Step>
              <Step n={2}>Tap <Share className="inline size-4 align-text-bottom" /> <b>Share</b>, then <PlusSquare className="inline size-4 align-text-bottom" /> <b>Add to Home Screen</b> → <b>Add</b>.</Step>
              <Step n={3}>Close Safari and open <b>Claude Remote</b> from the Home Screen icon. Log in again (the app has its own cookies).</Step>
              <Step n={4}>Come back to this tab and tap <b>Enable on this device</b>, then <b>Allow</b>.</Step>
            </ol>
            {ios && !P.isStandalone() && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-500/30">You are in a browser tab right now — install first (steps 1–3).</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">On Android, notifications work in Chrome even without installing; installing gives a full-screen app and a Home Screen icon.</p>
            <ol className="space-y-2.5">
              <Step n={1}>Open this panel in <b>Chrome</b> (or Edge / Samsung Internet).</Step>
              <Step n={2}>Tap <MoreVertical className="inline size-4 align-text-bottom" /> menu → <b>Install app</b> (or <b>Add to Home screen</b>){android && installEvt ? ', or use the button above' : ''}.</Step>
              <Step n={3}>Open <b>Claude Remote</b> from the icon, tap <b>Enable on this device</b> and <b>Allow</b>.</Step>
            </ol>
          </div>
        )}
        <p className="text-xs text-muted-foreground">Requires HTTPS (the dev-box behind its gateway). Tapping a notification opens the project's terminal.</p>
      </div>
    </Card>
  )
}

export default function NotificationsPage({ onFlash }) {
  const [info, setInfo] = useState(null)
  const [mine, setMine] = useState('') // endpoint of this browser's subscription
  const [perm, setPerm] = useState(P.permission())
  const [busy, setBusy] = useState('')
  const [installEvt, setInstallEvt] = useState(P.getInstallPrompt())
  const flash = (r) => onFlash?.({ ok: !!(r && r.ok), msg: (r && r.msg) || (r && r.ok ? 'done' : 'failed') })

  const load = useCallback(async () => {
    const [r, sub] = await Promise.all([P.pushInfo().catch(() => null), P.currentSubscription()])
    if (r && r.ok) setInfo(r)
    setMine(sub ? sub.endpoint : '')
    setPerm(P.permission())
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => P.onInstallPrompt(setInstallEvt), [])

  const act = async (key, fn) => {
    setBusy(key)
    const r = await fn().catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    flash(r)
    load()
    return r
  }
  const enable = () => act('enable', () => P.enableOnThisDevice(info.publicKey))
  const disable = () => act('disable', () => P.disableOnThisDevice())
  const setEvent = (k, v) => act('ev-' + k, () => P.pushPrefs({ events: { [k]: v } }))
  const setPref = (k, v) => act('pref-' + k, () => P.pushPrefs({ [k]: v }))

  if (!info) return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-56" /></div>

  const thisOn = !!mine && info.devices.some((d) => d.endpoint === mine)
  const canPush = P.pushSupported()
  const hooksOk = info.hooksSeenAt && Date.now() - info.hooksSeenAt < 7 * 864e5

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Card title="This device" actions={<Btn size="sm" variant="ghost" onClick={load} title="refresh"><RefreshCw className="size-3.5" /></Btn>}>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <Pill ok={thisOn}>{thisOn ? 'notifications on' : 'notifications off'}</Pill>
            <Pill ok={P.isStandalone()}>{P.isStandalone() ? 'installed app' : 'browser tab'}</Pill>
            <Pill ok={perm === 'granted'}>permission: {perm}</Pill>
            <Pill ok={!!hooksOk}>{hooksOk ? `Claude hooks seen ${fmtAgo(info.hooksSeenAt)}` : 'no Claude hook events yet'}</Pill>
          </div>
          {!info.supported && <p className="text-sm text-destructive">Web Push is not available on the server (the web-push package is missing).</p>}
          {!canPush && <p className="text-sm text-muted-foreground">{P.isIOS() && !P.isStandalone() ? 'Install the app from Safari first (steps below), then open it from the Home Screen.' : 'This browser does not support Web Push.'}</p>}
          <div className="flex flex-col gap-2 sm:flex-row">
            {thisOn ? (
              <>
                <Btn variant="accent" busy={busy === 'test-me'} onClick={() => act('test-me', () => P.pushTest(info.devices.find((d) => d.endpoint === mine).id))} className="w-full sm:w-auto"><Send className="size-4" /> Send test</Btn>
                <Btn busy={busy === 'disable'} onClick={disable} className="w-full sm:w-auto"><BellOff className="size-4" /> Disable on this device</Btn>
              </>
            ) : (
              <Btn variant="accent" busy={busy === 'enable'} disabled={!canPush || !info.supported} onClick={enable} className="w-full sm:w-auto"><BellRing className="size-4" /> Enable on this device</Btn>
            )}
          </div>
        </div>
      </Card>

      <Card title="Notify me when…">
        <ul className="divide-y divide-border">
          {Object.entries(info.events).map(([k, label]) => (
            <li key={k} className="flex items-center justify-between gap-3 py-3">
              <span className="text-sm text-foreground">{label}</span>
              <Toggle on={!!info.prefs.events[k]} busy={busy === 'ev-' + k} label={label} onChange={(v) => setEvent(k, v)} />
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 py-3">
            <span className="text-sm text-muted-foreground">"Finished" only for tasks longer than</span>
            <select value={info.prefs.doneMinSeconds} onChange={(e) => setPref('doneMinSeconds', Number(e.target.value))}
              className="rounded-md border border-input bg-input/20 px-2 py-1.5 text-sm text-foreground">
              {[0, 10, 20, 30, 60, 120, 300].map((s) => <option key={s} value={s}>{s ? (s < 60 ? `${s}s` : `${s / 60} min`) : 'any'}</option>)}
            </select>
          </li>
          <li className="flex items-center justify-between gap-3 py-3">
            <span className="text-sm text-muted-foreground">Usage warning from</span>
            <select value={info.prefs.usagePct} onChange={(e) => setPref('usagePct', Number(e.target.value))}
              className="rounded-md border border-input bg-input/20 px-2 py-1.5 text-sm text-foreground">
              {[70, 80, 90, 95].map((s) => <option key={s} value={s}>{s}%</option>)}
            </select>
          </li>
        </ul>
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"><Webhook className="mt-0.5 size-3.5 shrink-0" /> "Finished" and "waiting" come from Claude Code hooks, so they work with the panel closed. Repeats are merged (same event and project within a few minutes) and at most 12 pushes go out per 10 minutes.</p>
      </Card>

      <Card title="Devices" subtitle={`${info.devices.length} registered`}
        actions={info.devices.length > 0 && <Btn size="sm" busy={busy === 'test-all'} onClick={() => act('test-all', () => P.pushTest(''))}><Send className="size-3.5" /> Test all</Btn>}>
        {info.devices.length === 0 ? <Empty>no devices yet — enable notifications on your phone</Empty> : (
          <ul className="divide-y divide-border">
            {info.devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-3">
                <Smartphone className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-foreground">{d.name}{d.endpoint === mine && <span className="ml-1.5 text-xs text-primary">(this device)</span>}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {d.service} · added {fmtAgo(d.createdAt)}{d.lastOkAt ? ` · last delivered ${fmtAgo(d.lastOkAt)}` : ''}
                    {d.lastError && <span className="text-destructive"> · {d.lastError}</span>}
                  </div>
                </div>
                <Btn size="sm" variant="ghost" title="send test" busy={busy === 'test-' + d.id} onClick={() => act('test-' + d.id, () => P.pushTest(d.id))}><Send className="size-3.5" /></Btn>
                <Btn size="sm" variant="ghost" title="remove" busy={busy === 'rm-' + d.id} onClick={() => act('rm-' + d.id, () => P.pushUnsubscribe({ id: d.id }))}><Trash2 className="size-3.5" /></Btn>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <InstallGuide installEvt={installEvt} onInstall={() => P.promptInstall().then(load)} />

      <Card title="Recent">
        {info.recent.length === 0 ? <Empty>nothing yet</Empty> : (
          <ul className="space-y-1.5">
            {info.recent.map((e, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-foreground/90">{e.title || e.event}</span>
                <span className="shrink-0 text-muted-foreground">{e.skipped ? `skipped: ${e.skipped}` : `sent ${e.sent || 0}${e.failed ? `, failed ${e.failed}` : ''}`} · {fmtAgo(e.t)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
