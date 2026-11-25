import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Cpu, Radio, RefreshCw, Activity, Plus, Power, Wifi, WifiOff, Save, UserRound, Tag, SquareTerminal, FolderOpen, Trash2, Settings2, History, DatabaseBackup, Pencil, HardDrive, MemoryStick, Gauge, Clock, ArrowUpCircle, CheckCircle2, ExternalLink, BarChart3, Pause, Play, ListTree, Pin } from 'lucide-react'
import { Dot, Btn, Chip, Modal, Drawer, ActivityBadge, inputCls, Skeleton, useConfirm } from '../components/ui.jsx'
import { fmtInt, fmtTok, fmtSize, fmtDate, fmtUsd, fmtUptime } from '../lib/format.js'
import * as api from '../api.js'
import { UsageWidget } from '../components/UsageLimits.jsx'
import { t, getLang } from '../lib/i18n.js'
import { TR } from '../lib/i18n-rich.jsx'

const SESSION_MODES = [
  ['new', 'smode.new'],
  ['continue', 'smode.continue'],
  ['pinned', 'smode.pinned'],
]

function StatItem({ icon: Icon, label, children, warn, className = '' }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl border bg-accent px-3 py-2.5 sm:p-3 ${warn ? 'border-amber-500/40' : 'border-border'} ${className}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? 'text-amber-600 dark:text-amber-300' : 'text-primary'}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="break-words text-sm text-foreground sm:truncate">{children}</div>
      </div>
    </div>
  )
}
const pct = (p) => (p >= 90 ? 'bg-rose-400' : p >= 75 ? 'bg-amber-400' : 'bg-emerald-400')
function Meter({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-xl bg-accent p-3 border">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-primary" /> {label}
        </span>
        <span className="font-mono text-sm text-foreground/80">{value}%</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-background">
        <div className={`h-full rounded-full ${pct(value)}`} style={{ width: Math.min(100, value) + '%' }} />
      </div>
      {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

// linha fina (sparkline) 0-100% para o historico de CPU/memoria — sem lib de grafico
function MiniLine({ points, color }) {
  if (!points || points.length < 2) return <div className="flex h-10 items-center text-[11px] text-muted-foreground">{t('dash.noHistory')}</div>
  const w = 100, h = 32
  const path = points.map((v, i) => `${(i / (points.length - 1)) * w},${h - Math.min(100, Math.max(0, v || 0)) / 100 * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-10 w-full">
      <polyline points={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// Saude do host + versao do Claude Code (com "atualizar"); CPU/memoria + top processos.
// So consulta /api/health com a aba visivel (achado @qa 2026-10-09: painel "CPU-light").
export function HealthCard({ onFlash, compact }) {
  const [h, setH] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () =>
    api
      .health()
      .then((r) => {
        if (r.ok) setH(r)
      })
      .catch(() => {})
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') load() }
    load()
    const t = setInterval(tick, 60000)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  const update = async () => {
    setBusy(true)
    const r = await api.claudeUpdate().catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    onFlash?.(r)
    load()
  }
  if (!h) return <Skeleton className="h-24" />
  const c = h.claude || {}
  const history = h.history || []
  const top = h.top || []
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Meter icon={HardDrive} label={t('dash.disk')} value={h.disk?.pct ?? 0} hint={h.disk ? t('dash.diskHint', { used: fmtSize(h.disk.used), total: fmtSize(h.disk.total), free: fmtSize(h.disk.avail) }) : ''} />
        <Meter icon={MemoryStick} label={t('dash.mem')} value={h.mem?.pct ?? 0} hint={h.mem ? t('dash.memHint', { used: fmtSize(h.mem.used), total: fmtSize(h.mem.total) }) : ''} />
        <Meter icon={Gauge} label="CPU" value={h.cpu?.pct ?? 0} hint={h.cpu?.cores ? t('dash.cores', { n: h.cpu.cores }) : ''} />
        <div className="rounded-xl bg-accent p-3 border">
          <div className="text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-primary" /> Load / CPUs
            </span>
          </div>
          <div className="mt-1 font-mono text-sm text-foreground">
            {(h.load || []).join(' · ')} <span className="text-muted-foreground">/ {h.cpus}</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            <Clock className="mr-1 inline h-3 w-3" />
            {t('dash.uptime', { host: fmtUptime(h.uptime), panel: fmtUptime(h.panel?.uptime) })}
          </div>
        </div>
        <div className={`col-span-2 rounded-xl border bg-accent p-3 lg:col-span-1 ${c.updateAvailable ? 'border-amber-500/40' : 'border-border'}`}>
          <div className="text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5 text-primary" /> Claude Code
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-sm text-foreground" title={c.current}>
            {c.currentNum || c.current || '?'}
            {c.latest && <span className="text-muted-foreground"> · npm {c.latest}</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {c.updateAvailable ? (
              <Btn size="sm" variant="accent" busy={busy} onClick={update} title="npm i -g @anthropic-ai/claude-code@latest">
                <ArrowUpCircle className="h-3.5 w-3.5" /> {t('dash.updateTo', { v: c.latest })}
              </Btn>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" /> {c.latest ? t('dash.upToDate') : t('dash.noNpm')}
              </span>
            )}
            {!compact && (
              <Link to="/account" className="text-[11px] text-muted-foreground hover:text-foreground/80">
                {t('dash.details')}
              </Link>
            )}
          </div>
        </div>
      </div>

      {!compact && (history.length > 0 || top.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {history.length > 0 && (
            <div className="rounded-xl bg-accent p-3 border">
              <div className="mb-1 text-[11px] text-muted-foreground">{t('dash.last6h')}</div>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="inline-block h-1.5 w-3 rounded-full bg-sky-400" /> CPU
                <span className="ml-3 inline-block h-1.5 w-3 rounded-full bg-amber-400" /> {t('dash.mem')}
              </div>
              <div className="relative">
                <MiniLine points={history.map((p) => p.cpu)} color="#38bdf8" />
                <div className="absolute inset-0">
                  <MiniLine points={history.map((p) => p.mem)} color="#f0a83c" />
                </div>
              </div>
            </div>
          )}
          {top.length > 0 && (
            <div className="rounded-xl bg-accent p-3 border">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <ListTree className="h-3.5 w-3.5 text-primary" /> {t('dash.top')}
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {top.slice(0, 5).map((p) => (
                    <tr key={p.pid} className="border-t border-border first:border-0">
                      <td className="py-1 pr-2 text-muted-foreground">{p.pid}</td>
                      <td className="py-1 pr-2 truncate text-foreground" title={p.comm}>{p.comm}</td>
                      <td className="py-1 pr-2 text-right font-mono text-muted-foreground">{(p.pcpu ?? 0).toFixed(0)}% cpu</td>
                      <td className="py-1 text-right font-mono text-muted-foreground">{fmtSize(p.rss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Dashboard({ data, activity, refresh, onFlash, showNew, setShowNew }) {
  const [busy, setBusy] = useState('')
  const [form, setForm] = useState({ name: '', autoStartClaude: true, autoRemote: true })
  const [drawer, setDrawer] = useState(null) // nome do projeto em configuracao

  const run = async (key, fn) => {
    setBusy(key)
    try {
      const r = await fn()
      if (r && typeof r.ok === 'boolean') onFlash(r)
      return r
    } catch (e) {
      onFlash({ ok: false, msg: e.message })
      return null
    } finally {
      setBusy('')
      refresh()
    }
  }
  const createNow = () =>
    run('create', async () => {
      const r = await api.createProject(form.name.trim(), form.autoStartClaude, form.autoRemote)
      if (r.ok) {
        setForm({ name: '', autoStartClaude: true, autoRemote: true })
        setShowNew(false)
      }
      return r
    })

  const [usage, setUsage] = useState(null)
  useEffect(() => {
    api.usage().then((r) => { if (r.ok) setUsage(r.usage) }).catch(() => {})
  }, [])

  const login = data.login || { logged: false, account: '' }
  const u = usage || { today: {}, total: {} }
  const projects = data.projects || []
  const actOf = (p) => (activity && activity[p.session] && activity[p.session].state) || p.activity || 'off'
  const running = projects.filter((p) => p.claudeRunning).length
  const off = projects.filter((p) => p.enabled === false).length
  const waiting = projects.filter((p) => actOf(p) === 'prompt').length
  const drawerProj = drawer && projects.find((p) => p.name === drawer)

  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      {/* Resumo */}
      <section className="order-1 rounded-lg border bg-card p-3 sm:p-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
          <StatItem icon={UserRound} label={t('account.claude')} warn={!login.logged} className="col-span-2 sm:col-span-1">
            <Link to={login.logged ? '/account' : '/account?login=1'} className="inline-flex items-center gap-2 hover:underline">
              <Dot on={login.logged} /> {login.logged ? login.account || t('account.loggedIn') : t('dash.loggedOutClick')}
            </Link>
          </StatItem>
          <StatItem icon={Cpu} label={t('dash.sessions')}>
            <span className="font-mono text-sm text-foreground">
              {running}/{projects.length}
            </span>{' '}
            {t('dash.withClaude')}{off ? <span className="text-muted-foreground">{t('dash.offCount', { n: off })}</span> : ''}
            {waiting ? <span className="text-rose-600 dark:text-rose-300">{t('dash.waitingCount', { n: waiting })}</span> : ''}
          </StatItem>
          <StatItem icon={BarChart3} label={t('dash.today')}>
            <Link to="/report" className="text-sm hover:underline">
              <span className="font-mono">{fmtTok((u.today?.in || 0) + (u.today?.out || 0))}</span> tokens · <span className="font-mono">{fmtUsd(u.today?.cost)}</span> · <span className="font-mono">{fmtInt(u.today?.messages)}</span> msgs
            </Link>
          </StatItem>
        </div>
        <div className="mt-4 border-t border-border pt-4 empty:hidden">
          <UsageWidget />
        </div>
      </section>

      {/* Saude do host: no celular vem DEPOIS dos projetos (o que se abre o painel p/ ver) */}
      <section className="order-3 rounded-lg border bg-card p-3 sm:order-2 sm:p-5">
        <HealthCard onFlash={onFlash} />
      </section>

      {/* Projetos */}
      <section className="order-2 space-y-3 sm:order-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-medium text-foreground">
            {t('dash.projects')} <span className="font-mono text-xs text-muted-foreground">({projects.length})</span>
          </h2>
          {data.remoteNameForced ? (
            <span className="text-[11px] text-muted-foreground">
              {t('dash.remoteFixed')} <code className="font-mono text-xs">/remote-control {data.remoteNameForced}</code>
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">{t('dash.remoteName')}</span>
          )}
        </div>
        {projects.length === 0 && (
          <div className="rounded-lg bg-card p-8 text-center text-sm text-muted-foreground border">
            {t('dash.noProjects')}{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => setShowNew(true)}>
              {t('dash.createFirst')}
            </button>
            .
          </div>
        )}
        {projects.map((p, idx) => {
          const act = actOf(p)
          const on = p.enabled !== false
          const accent = !on ? 'bg-muted' : act === 'prompt' ? 'bg-rose-400 animate-pulse' : act === 'busy' ? 'bg-amber-400 animate-pulse' : p.claudeRunning ? 'bg-success/60' : 'bg-muted'
          return (
            <div key={p.name} className={`relative animate-fade-up overflow-hidden rounded-lg border bg-card p-4 transition duration-200 hover:border-primary/30 sm:p-5 sm:hover:-translate-y-px ${!on ? 'opacity-70' : ''}`} style={{ animationDelay: `${idx * 40}ms` }}>
              <div className={`absolute inset-y-0 left-0 w-[3px] ${accent}`} />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <Link to={'/terminal/' + encodeURIComponent(p.name)} className="truncate text-lg font-semibold text-foreground hover:underline sm:text-base">
                        {p.name}
                      </Link>
                      {!on ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground border">{t('dash.off')}</span> : p.claudeRunning ? <ActivityBadge state={act} since={p.activitySince} /> : <ActivityBadge state="off" />}
                      {p.paused && <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-300" title={t('dash.pausedTitle')}>{t('dash.paused')}</span>}
                      {p.autoResumeAt > 0 && <span className="rounded-full border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-600 dark:text-sky-300" title={t('dash.autoResumeTitle')}>{t('dash.autoResume', { time: new Date(p.autoResumeAt).toLocaleString(getLang(), { dateStyle: 'short', timeStyle: 'short' }) })}</span>}
                    </div>
                    {/* celular: configurar fica no canto do cartao (no desktop, no fim dos botoes) */}
                    <Btn variant="ghost" className="-mr-2 -mt-1 sm:hidden" onClick={() => setDrawer(p.name)} title={t('dash.configure')}>
                      <Settings2 className="h-4 w-4" />
                    </Btn>
                  </div>
                  {act === 'prompt' && on && p.claudeRunning && (
                    <Link to={'/terminal/' + encodeURIComponent(p.name)} className="mt-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      <SquareTerminal className="h-4 w-4 shrink-0" /> {t('dash.waitingBanner')}
                    </Link>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground sm:mt-1.5 sm:gap-y-1">
                    <span className="inline-flex items-center gap-1.5">
                      <Activity className="h-3.5 w-3.5 text-muted-foreground" /> tmux <Dot on={p.up} /> {p.up ? t('dash.up') : t('dash.down')}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Cpu className="h-3.5 w-3.5 text-muted-foreground" /> Claude <Dot on={p.claudeRunning} /> {p.claudeRunning ? t('dash.running') : t('dash.stopped')}
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Radio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> {p.autoRemote ? <code className="truncate font-mono text-xs text-foreground/80">{p.remoteCmd}</code> : <span className="text-muted-foreground">{t('dash.remoteOff')}</span>}
                    </span>
                    {p.initLine && (
                      <span className="w-full truncate text-muted-foreground sm:w-auto" title={p.initLine}>
                        {t('dash.firstLine')} “{p.initLine.slice(0, 60)}
                        {p.initLine.length > 60 ? '…' : ''}”
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Chip Icon={Power} on={on} busy={busy === `power:${p.name}`} labelOn={t('dash.on')} labelOff={t('dash.offChip')} onClick={() => run(`power:${p.name}`, () => api.setPower(p.name, !on))} />
                    <Chip Icon={Cpu} on={p.autoStartClaude} busy={busy === `cfg:${p.name}:autoStartClaude`} labelOn="Claude: ON" labelOff="Claude: OFF" onClick={() => run(`cfg:${p.name}:autoStartClaude`, () => api.setConfig(p.name, 'autoStartClaude', !p.autoStartClaude))} />
                    <Chip Icon={p.autoRemote ? Wifi : WifiOff} on={p.autoRemote} busy={busy === `cfg:${p.name}:autoRemote`} labelOn="Remote: ON" labelOff="Remote: OFF" onClick={() => run(`cfg:${p.name}:autoRemote`, () => api.setConfig(p.name, 'autoRemote', !p.autoRemote))} />
                  </div>
                </div>
                {/* acoes: no celular, grade de botoes grandes (1 toque, cabe o polegar) */}
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
                  <Link to={'/terminal/' + encodeURIComponent(p.name)} className={`${act === 'prompt' && on ? 'ring-2 ring-destructive/60 ' : ''}inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 sm:h-auto sm:py-1.5 sm:text-[13px]`}>
                    <SquareTerminal className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> Terminal
                  </Link>
                  {p.remoteUrl ? (
                    <a href={p.remoteUrl} target="_blank" rel="noreferrer" title={t('dash.openRemoteTitle')} className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-sky-500/90 px-3 text-sm font-medium text-white transition hover:bg-sky-500 sm:h-auto sm:py-1.5 sm:text-[13px]">
                      <ExternalLink className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> {t('dash.openRemote')}
                    </a>
                  ) : (
                    <Link to={'/files/projects/' + encodeURIComponent(p.name)} className="inline-flex h-11 items-center justify-center gap-1.5 rounded-lg bg-secondary px-3 text-sm font-medium text-foreground transition hover:bg-secondary/80 sm:hidden">
                      <FolderOpen className="h-4 w-4" /> {t('nav.files')}
                    </Link>
                  )}
                  {on && p.claudeRunning && (
                    <Btn busy={busy === `remote:${p.name}`} className="h-11 justify-center sm:h-8" onClick={() => run(`remote:${p.name}`, () => api.reconnectRemote(p.name))} title={t('dash.remoteAgainTitle')}>
                      <Radio className="h-3.5 w-3.5" /> /remote-control
                    </Btn>
                  )}
                  <Btn busy={busy === `restart:${p.name}`} className="h-11 justify-center sm:h-8" onClick={() => run(`restart:${p.name}`, () => api.restartProject(p.name))} title={on ? t('dash.restartTitle') : t('dash.powerOnTitle')}>
                    <RefreshCw className="h-3.5 w-3.5" /> {on ? t('dash.restart') : t('dash.powerOn')}
                  </Btn>
                  <Link to={'/files/projects/' + encodeURIComponent(p.name)} className={`${p.remoteUrl ? 'inline-flex' : 'hidden sm:inline-flex'} h-11 items-center justify-center gap-1.5 rounded-lg bg-secondary px-3 text-sm font-medium text-foreground transition hover:bg-secondary/80 sm:h-auto sm:py-1.5 sm:text-[13px]`}>
                    <FolderOpen className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> {t('nav.files')}
                  </Link>
                  {p.paused ? (
                    <Btn variant="accent" className="h-11 justify-center sm:h-8" busy={busy === `unpause:${p.name}`} onClick={() => run(`unpause:${p.name}`, () => api.unpauseProject(p.name))} title={t('dash.resumeTitle')}>
                      <Play className="h-3.5 w-3.5" /> {t('dash.resume')}
                    </Btn>
                  ) : (
                    p.claudeRunning && (
                      <Btn variant="ghost" className="h-11 justify-center border border-border sm:h-8 sm:border-transparent" busy={busy === `pause:${p.name}`} onClick={() => run(`pause:${p.name}`, () => api.pauseProject(p.name))} title={t('dash.pauseTitle')}>
                        <Pause className="h-3.5 w-3.5" /> {t('dash.pause')}
                      </Btn>
                    )
                  )}
                  <Btn variant="ghost" className="hidden sm:inline-flex" onClick={() => setDrawer(p.name)} title={t('dash.configure')}>
                    <Settings2 className="h-3.5 w-3.5" />
                  </Btn>
                </div>
              </div>
            </div>
          )
        })}
      </section>

      {drawerProj && <ProjectDrawer p={drawerProj} data={data} busy={busy} run={run} onClose={() => setDrawer(null)} onFlash={onFlash} />}

      {/* Modal: novo projeto */}
      {showNew && (
        <Modal title={t('projects.new')} icon={Plus} onClose={() => setShowNew(false)}>
          <label className="mb-1 block text-xs text-muted-foreground">{t('dash.projectName')}</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createNow()
            }}
            autoFocus
            placeholder="meu-projeto"
            pattern="[A-Za-z0-9._-]{1,64}"
            className={`w-full ${inputCls} px-3 py-2`}
          />
          <div className="mt-4 space-y-2">
            <div className="text-xs text-muted-foreground">{t('dash.services')}</div>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm text-foreground border">
              <input type="checkbox" checked={form.autoStartClaude} onChange={(e) => setForm((f) => ({ ...f, autoStartClaude: e.target.checked }))} className="accent-[#D97757]" />
              <Cpu className="h-4 w-4 text-primary" /> {t('settings.autoStart')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm text-foreground border">
              <input type="checkbox" checked={form.autoRemote} onChange={(e) => setForm((f) => ({ ...f, autoRemote: e.target.checked }))} className="accent-[#D97757]" />
              <Radio className="h-4 w-4 text-primary" /> {t('settings.autoRemote')}
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setShowNew(false)}>
              {t('common.cancel')}
            </Btn>
            <Btn variant="accent" busy={busy === 'create'} onClick={createNow} disabled={!form.name.trim()}>
              <Power className="h-3.5 w-3.5" /> {t('dash.create')}
            </Btn>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            <TR k="dash.createHint" vars={{ dir: data.projectsDir }} />
          </p>
        </Modal>
      )}
    </div>
  )
}

// Disk use of the project and of the agents' work copies (.claude/worktrees). Only copies that
// are old, have no uncommitted changes and have nothing running inside can be removed
// (the server checks again before removing: server/disk.js).
function DiskSection({ name, onFlash }) {
  const [d, setD] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmEl, ask] = useConfirm()
  const load = (fresh) => api.projectDisk(name, fresh).then(setD).catch(() => setD({ ok: false }))
  useEffect(() => { load(false) }, [name]) // eslint-disable-line react-hooks/exhaustive-deps
  const clean = async () => {
    if (!(await ask(t('disk.cleanAsk', { n: d.removableCount, size: fmtSize(d.removableBytes) }), { yes: t('disk.cleanYes'), danger: true }))) return
    setBusy(true)
    const r = await api.cleanWorktrees(name).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    onFlash?.(r)
    load(true)
  }
  const why = (w) => (w.inUse ? t('disk.inUse') : w.dirty ? t('disk.dirty') : w.removable ? t('disk.old') : t('disk.recent'))
  return (
    <section className="rounded-xl border border-border bg-sidebar p-4" data-testid="disk-section">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"><HardDrive className="h-3.5 w-3.5" /> {t('disk.title')}</h4>
      {!d ? <Skeleton className="h-10" /> : !d.ok ? <p className="text-xs text-destructive">{d.msg || t('disk.error')}</p> : (
        <div className="space-y-2 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>{t('disk.project')}: <b className="font-mono">{d.bytes == null ? '—' : fmtSize(d.bytes)}</b></span>
            {d.worktrees.length > 0 && <span>{t('disk.copies', { n: d.worktrees.length })}: <b className="font-mono">{fmtSize(d.worktreesBytes)}</b></span>}
          </div>
          {d.worktrees.length > 0 && (
            <ul className="max-h-40 space-y-1 overflow-auto rounded-lg border bg-background p-2">
              {d.worktrees.map((w) => (
                <li key={w.name} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono" title={w.branch || w.name}>{w.name}</span>
                  <span className="shrink-0 text-muted-foreground">{w.bytes == null ? '—' : fmtSize(w.bytes)} · <span className={w.removable ? 'text-warning' : ''}>{why(w)}</span></span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            {d.removableCount > 0 && (
              <Btn variant="danger" busy={busy} onClick={clean}><Trash2 className="h-3.5 w-3.5" /> {t('disk.clean', { n: d.removableCount, size: fmtSize(d.removableBytes) })}</Btn>
            )}
            <Btn variant="ghost" onClick={() => { setD(null); load(true) }}><RefreshCw className="h-3.5 w-3.5" /> {t('common.refresh')}</Btn>
          </div>
          {d.worktrees.length > 0 && <p className="text-muted-foreground">{t('disk.hint', { days: d.days })}</p>}
        </div>
      )}
      {confirmEl}
    </section>
  )
}

// Drawer "Configurar projeto": primeira linha, remote, renomear, historico, backup, excluir
function ProjectDrawer({ p, data, busy, run, onClose, onFlash }) {
  const [initLine, setInitLine] = useState(p.initLine || '')
  const [newName, setNewName] = useState(p.name)
  const [renaming, setRenaming] = useState(false)
  const [delTyped, setDelTyped] = useState('')
  const [bk, setBk] = useState(null)
  useEffect(() => {
    api
      .backupStatus()
      .then((r) => {
        if (r.ok) setBk(r.projects.find((x) => x.name === p.name) || null)
      })
      .catch(() => {})
  }, [p.name])

  const Section = ({ title, icon: Icon, children, danger }) => (
    <section className={`rounded-xl p-4 ${danger ? 'border border-rose-500/20 bg-rose-500/5' : 'border border-border bg-sidebar'}`}>
      <h4 className={`mb-2 flex items-center gap-2 text-xs font-medium ${danger ? 'text-destructive' : 'text-muted-foreground'}`}>
        <Icon className="h-3.5 w-3.5" /> {title}
      </h4>
      {children}
    </section>
  )

  return (
    <Drawer title={t('dash.configureTitle', { name: p.name })} icon={Settings2} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-xs text-muted-foreground">
          {p.dir} · {t('dash.sessionLabel')} <code className="font-mono text-xs">{p.session}</code>
        </div>

        <Section title={t('dash.firstLineTitle')} icon={Pencil}>
          <p className="mb-2 text-xs text-muted-foreground">{t('dash.firstLineHint')}</p>
          <div className="flex items-center gap-2">
            <input
              value={initLine}
              onChange={(e) => setInitLine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run(`init:${p.name}`, () => api.setInitLine(p.name, initLine))
              }}
              placeholder={t('dash.firstLinePh')}
              className={`flex-1 ${inputCls}`}
            />
            <Btn variant="accent" busy={busy === `init:${p.name}`} onClick={() => run(`init:${p.name}`, () => api.setInitLine(p.name, initLine))}>
              <Save className="h-3.5 w-3.5" />
            </Btn>
          </div>
        </Section>

        <Section title={t('dash.onRestart')} icon={Pin}>
          <p className="mb-2 text-xs text-muted-foreground">{t('dash.onRestartHint')}</p>
          <select value={p.sessionMode || 'new'} onChange={(e) => run(`sessmode:${p.name}`, () => api.setSessionMode(p.name, e.target.value))} className={inputCls}>
            {SESSION_MODES.map(([k, label]) => (
              <option key={k} value={k}>{t(label)}</option>
            ))}
          </select>
          {(p.sessionMode || 'new') === 'pinned' && (
            <p className="mt-2 text-xs text-muted-foreground">
              {p.pinnedSession ? (
                <>
                  {t('dash.pinnedSession')} <code className="font-mono text-xs text-foreground/80">{String(p.pinnedSession).slice(0, 8)}</code> {t('dash.changeIn')}{' '}
                </>
              ) : (
                <>{t('dash.noPinned')} </>
              )}
              <Link to={'/history/' + encodeURIComponent(p.name)} onClick={onClose} className="text-primary hover:underline">
                {t('nav.history')}
              </Link>
            </p>
          )}
        </Section>

        <Section title={t('dash.remoteControl')} icon={Radio}>
          <div className="flex flex-wrap items-center gap-2">
            <Btn busy={busy === `remote:${p.name}`} onClick={() => run(`remote:${p.name}`, () => api.reconnectRemote(p.name))} title={t('dash.remoteAgainTitle')}>
              <Radio className="h-3.5 w-3.5" /> {t('dash.restartRemote')}
            </Btn>
            {p.remoteUrl && (
              <a href={p.remoteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/90 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-sky-500">
                <ExternalLink className="h-3.5 w-3.5" /> {t('dash.openLink')}
              </a>
            )}
            <span className="text-xs text-muted-foreground">
              {t('dash.command')} <code className="font-mono text-xs">{p.remoteCmd}</code>
            </span>
          </div>
        </Section>

        <Section title={t('dash.history')} icon={History}>
          <Link to={'/history/' + encodeURIComponent(p.name)} onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-secondary/80">
            <History className="h-3.5 w-3.5" /> {t('dash.viewConversations')}
          </Link>
        </Section>

        <DiskSection name={p.name} onFlash={onFlash} />

        <Section title="Backup (git)" icon={DatabaseBackup}>
          <div className="mb-2 text-xs text-muted-foreground">
            {bk === null ? (
              t('common.loading')
            ) : !bk?.git ? (
              t('dash.notGitRepo')
            ) : !bk.origin ? (
              t('dash.noOrigin')
            ) : bk.last ? (
              <>
                {t('dash.lastBackup')} <span className={bk.last.level === 'ok' ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300'}>{bk.last.level}</span> {t('dash.at')} {bk.last.ts} — {bk.last.msg}
              </>
            ) : (
              t('dash.noBackup')
            )}
            {bk?.dirty ? <span className="text-amber-600 dark:text-amber-300">{t('dash.dirtyFiles', { n: bk.dirty })}</span> : null}
          </div>
          <Btn busy={busy === `backup:${p.name}`} onClick={() => run(`backup:${p.name}`, () => api.backupRun(p.name))}>
            <DatabaseBackup className="h-3.5 w-3.5" /> {t('dash.backupNow')}
          </Btn>
        </Section>

        <Section title={t('dash.rename')} icon={Pencil}>
          <p className="mb-2 text-xs text-muted-foreground">
            <TR k="dash.renameHint" />
          </p>
          {renaming ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                pattern="[A-Za-z0-9._-]{1,64}"
                autoFocus
                className={`w-48 ${inputCls}`}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(false)
                }}
              />
              <Btn
                variant="accent"
                busy={busy === `rename:${p.name}`}
                disabled={!newName.trim() || newName === p.name}
                onClick={() =>
                  run(`rename:${p.name}`, async () => {
                    const r = await api.renameProject(p.name, newName.trim())
                    if (r.ok) onClose()
                    return r
                  })
                }
              >
                <Save className="h-3.5 w-3.5" /> {t('common.save')}
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => {
                  setRenaming(false)
                  setNewName(p.name)
                }}
              >
                {t('common.cancel')}
              </Btn>
            </div>
          ) : (
            <Btn variant="ghost" onClick={() => setRenaming(true)}>
              <Pencil className="h-3.5 w-3.5" /> {t('dash.changeName')}
            </Btn>
          )}
        </Section>

        <Section title={t('dash.delete')} icon={Trash2} danger>
          <p className="mb-2 text-xs text-muted-foreground">
            {t('dash.deletes')}{' '}
            <code className="font-mono text-xs text-foreground/80">
              {data.projectsDir}/{p.name}
            </code>{' '}
            {t('dash.deleteHint')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input value={delTyped} onChange={(e) => setDelTyped(e.target.value)} placeholder={p.name} className={`w-48 ${inputCls}`} />
            <Btn
              variant="danger"
              busy={busy === `delete:${p.name}`}
              disabled={delTyped !== p.name}
              onClick={() =>
                run(`delete:${p.name}`, async () => {
                  const r = await api.deleteProject(p.name)
                  if (r.ok) onClose()
                  return r
                })
              }
            >
              <Trash2 className="h-3.5 w-3.5" /> {t('dash.deleteForever')}
            </Btn>
          </div>
        </Section>
      </div>
    </Drawer>
  )
}
