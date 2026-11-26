// Remote hub of a person (/remote?key=<key>). Sections: Projects (this server + the person's saved
// links, of this or other servers), Accounts (plans, limits, which account each project uses),
// Usage (cost/tokens, report by dates), Server (CPU, memory, disk, Claude version), Links (manage
// the saved list). Phone: bottom tab bar; desktop (>= 1024px): left sidebar, wide content.
// The section is in the URL hash (#/accounts) so a reload or the back button keeps the place.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FolderKanban, UserRound, BarChart3, Server, Link2, KeyRound, RefreshCw, MessageSquare, ExternalLink,
  Plus, Trash2, ArrowUp, ArrowDown, Pencil, Check, X, Cpu, MemoryStick, Globe, CircleAlert,
} from 'lucide-react'
import { ApiError, api, chatHref, hubKey, isSelf, parseLink, remoteChatHref, remoteChatMe, remoteChatState, remoteProjects } from './api.js'
import { t } from '../lib/i18n.js'
import { fmtAgo, fmtInt, fmtSize, fmtTok, fmtUptime, fmtUsd } from '../lib/format.js'

const cx = (...a) => a.filter(Boolean).join(' ')
const accountLabel = (a) => (a ? a.label || (a.isDefault ? t('acct.defaultLabel') : a.id) : '')
const SECTIONS = [
  { id: 'projects', icon: FolderKanban },
  { id: 'accounts', icon: UserRound },
  { id: 'usage', icon: BarChart3 },
  { id: 'server', icon: Server },
  { id: 'links', icon: Link2 },
]
export const parseSection = (hash) => {
  const s = String(hash || '').replace(/^#\/?/, '')
  return SECTIONS.some((x) => x.id === s) ? s : 'projects'
}

// ---------------------------------------------------------------- small pieces
function useLoad(fn, deps = [], everyMs = 0) {
  const [s, setS] = useState({ data: null, error: null, loading: true })
  const load = useCallback(() => {
    setS((x) => ({ ...x, loading: true }))
    return fn().then((data) => setS({ data, error: null, loading: false }), (error) => setS((x) => ({ data: x.data, error, loading: false })))
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load()
    if (!everyMs) return undefined
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, everyMs)
    return () => clearInterval(id)
  }, [load, everyMs])
  return { ...s, reload: load }
}
const Spinner = () => <RefreshCw aria-hidden className="size-4 animate-spin text-muted-foreground" />
function Panel({ title, icon: Icon, right, children, testid }) {
  return (
    <section data-testid={testid} className="rounded-2xl border bg-card p-4 shadow-xs">
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium text-muted-foreground">{Icon && <Icon className="size-4 shrink-0" />}<span className="truncate">{title}</span></h2>
          {right}
        </div>
      )}
      {children}
    </section>
  )
}
function Btn({ children, onClick, variant = 'outline', disabled, className, title, type = 'button', testid }) {
  const v = { outline: 'border bg-background hover:bg-accent', brand: 'bg-foreground text-background hover:bg-foreground/85', ghost: 'hover:bg-accent', danger: 'text-destructive hover:bg-destructive/10' }[variant]
  return <button type={type} title={title} data-testid={testid} disabled={disabled} onClick={onClick} className={cx('inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-medium transition-colors disabled:opacity-50', v, className)}>{children}</button>
}
const ErrorLine = ({ error }) => (error ? <p className="flex items-center gap-1.5 text-sm text-destructive"><CircleAlert className="size-4" /> {error.status === 0 ? t('hub.offline') : error.message}</p> : null)
function Bar({ percent }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0))
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full', p >= 95 ? 'bg-destructive' : p >= 80 ? 'bg-amber-500' : 'bg-success')} style={{ width: `${p}%` }} />
    </div>
  )
}

// the state of a project's Claude, as a colored dot + word
const STATE = {
  working: ['bg-brand animate-pulse', 'hub.st.working'],
  busy: ['bg-brand animate-pulse', 'hub.st.working'],
  asking: ['bg-amber-500', 'hub.st.asking'],
  prompt: ['bg-amber-500', 'hub.st.asking'],
  idle: ['bg-success', 'hub.st.idle'],
  on: ['bg-success', 'hub.st.idle'],
  shell: ['bg-muted-foreground', 'hub.st.shell'],
  paused: ['bg-muted-foreground', 'hub.st.paused'],
  down: ['bg-muted-foreground', 'hub.st.down'],
  off: ['bg-muted-foreground/50', 'hub.st.off'],
  unknown: ['bg-muted-foreground/30', 'hub.st.unknown'],
}
// a project of the hub list: {claude: off|paused|down|shell|on, activity: busy|idle|prompt|off}
const hubState = (p) => (p.claude !== 'on' ? p.claude : p.activity === 'busy' ? 'busy' : p.activity === 'prompt' ? 'prompt' : 'idle')
function StateDot({ state }) {
  const [cls, key] = STATE[state] || STATE.unknown
  return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cx('size-2 shrink-0 rounded-full', cls)} />{t(key)}</span>
}
function ProjectRow({ name, state, sub, href, testid }) {
  return (
    <li>
      <a href={href} data-testid={testid} className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-accent active:bg-accent">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold uppercase text-foreground/80">{(name || '?').slice(0, 2)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name || t('hub.chatLink')}</span>
          <span className="flex min-w-0 items-center gap-2"><StateDot state={state} />{sub && <span className="truncate text-xs text-muted-foreground">· {sub}</span>}</span>
        </span>
        <MessageSquare className="size-5 shrink-0 text-muted-foreground" aria-label={t('hub.openChat')} />
      </a>
    </li>
  )
}

// ---------------------------------------------------------------- Projects
function ThisServer({ accounts }) {
  const { data, error, loading, reload } = useLoad(() => api.projects(), [], 10000)
  const label = (id) => accountLabel((accounts || []).find((a) => a.id === id))
  return (
    <Panel testid="hub-local" title={data?.server?.name ? t('hub.thisServerNamed', { name: data.server.name }) : t('hub.thisServer')} icon={Server}
      right={<Btn variant="ghost" onClick={reload} title={t('hub.refresh')}>{loading ? <Spinner /> : <RefreshCw className="size-4" />}</Btn>}>
      <ErrorLine error={error} />
      {data && (data.projects.length === 0 ? <p className="text-sm text-muted-foreground">{t('hub.noProjects')}</p> : (
        <ul className="-mx-2 grid gap-1 lg:grid-cols-2">
          {data.projects.map((p) => <ProjectRow key={p.name} testid="hub-project" name={p.name} state={hubState(p)} sub={(accounts || []).length > 1 ? label(p.account) : ''} href={chatHref(p.name)} />)}
        </ul>
      ))}
    </Panel>
  )
}
// a saved link: another hub (its project list) or one project chat (its state)
function SavedLink({ link }) {
  const l = useMemo(() => parseLink(link.url), [link.url])
  const { data, error, loading, reload } = useLoad(async () => {
    if (!l) return null
    if (l.kind === 'hub') return remoteProjects(l)
    const [me, st] = await Promise.all([remoteChatMe(l), remoteChatState(l).catch(() => null)])
    return { me, st }
  }, [link.url], 20000)
  const host = l ? new URL(l.base).host : ''
  if (!l) return null
  if (l.kind === 'hub') return (
    <Panel testid="hub-remote" title={link.label || data?.server?.name || host} icon={Globe}
      right={<Btn variant="ghost" onClick={reload} title={t('hub.refresh')}>{loading ? <Spinner /> : <RefreshCw className="size-4" />}</Btn>}>
      <p className="-mt-2 mb-2 truncate text-xs text-muted-foreground">{host}</p>
      <ErrorLine error={error} />
      {error && <a href={link.url} className="text-sm text-primary underline">{t('hub.openThere')}</a>}
      {data && (
        <ul className="-mx-2 grid gap-1 lg:grid-cols-2">
          {data.projects.map((p) => <ProjectRow key={p.name} testid="hub-remote-project" name={p.name} state={hubState(p)} href={remoteChatHref(l, p.name)} />)}
        </ul>
      )}
    </Panel>
  )
  const st = data?.st
  const state = error ? 'unknown' : !st ? 'unknown' : st.claude === 'off' ? (st.why === 'paused' ? 'paused' : 'off') : st.claude
  return <ProjectRow testid="hub-saved-chat" name={link.label || data?.me?.project || l.project} state={state} sub={host !== location.host ? host : ''} href={link.url} />
}
function ProjectsSection({ links, accounts }) {
  const list = (links || []).filter((x) => !isSelf(parseLink(x.url)))
  const chats = list.filter((x) => parseLink(x.url)?.kind === 'chat')
  const hubs = list.filter((x) => parseLink(x.url)?.kind === 'hub')
  return (
    <div className="space-y-4">
      <ThisServer accounts={accounts} />
      {chats.length > 0 && (
        <Panel testid="hub-saved" title={t('hub.savedChats')} icon={Link2}>
          <ul className="-mx-2 grid gap-1 lg:grid-cols-2">{chats.map((x) => <SavedLink key={x.id} link={x} />)}</ul>
        </Panel>
      )}
      {hubs.map((x) => <SavedLink key={x.id} link={x} />)}
    </div>
  )
}

// ---------------------------------------------------------------- Accounts
function Limits({ lim }) {
  if (!lim) return <p className="text-xs text-muted-foreground">{t('hub.noLimits')}</p>
  const wins = lim.windows || []
  return (
    <div className="space-y-2">
      {lim.status && lim.status !== 'ok' && lim.status !== 'pending' && <p className="text-xs text-amber-600 dark:text-amber-300">{lim.message}</p>}
      {wins.map((w) => (
        <div key={w.id} className={cx(lim.stale && 'opacity-60')}>
          <div className="mb-1 flex justify-between text-xs"><span className="text-foreground/80">{w.label}</span><span className="font-mono">{Math.round(w.percent || 0)}%</span></div>
          <Bar percent={w.percent} />
          {w.resetsAt && <div className="mt-0.5 text-[11px] text-muted-foreground">{t('hub.resets', { when: new Date(w.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}</div>}
        </div>
      ))}
      {lim.fetchedAt ? <p className="text-[11px] text-muted-foreground">{t('hub.updatedAgo', { ago: fmtAgo(lim.fetchedAt) })}</p> : null}
    </div>
  )
}
function AccountsSection({ acc, onChanged }) {
  const { data, error, loading, reload } = acc
  const projectsQ = useLoad(() => api.projects(), [])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState(null)
  const refresh = async () => { setBusy('limits'); await api.refreshLimits().catch(() => {}); setBusy(''); reload() }
  const switchTo = async (name, account) => {
    setBusy(name); setMsg(null)
    const r = await api.setAccount(name, account).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(''); setMsg(r); reload(); projectsQ.reload(); onChanged?.()
  }
  const list = data?.accounts || []
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <ErrorLine error={error} />
        <Btn className="ml-auto" onClick={refresh} disabled={busy === 'limits'} testid="hub-limits-refresh">{busy === 'limits' || loading ? <Spinner /> : <RefreshCw className="size-4" />} {t('hub.refreshLimits')}</Btn>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {list.map((a) => (
          <Panel key={a.id} testid="hub-account" title={accountLabel(a)} icon={UserRound}
            right={<span className={cx('rounded-full px-2 py-0.5 text-xs', a.logged ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>{a.logged ? (a.plan || t('hub.loggedIn')) : t('hub.loggedOut')}</span>}>
            {a.account && <p className="-mt-1 mb-3 truncate text-xs text-muted-foreground">{a.account}{a.org ? ` · ${a.org}` : ''}</p>}
            <Limits lim={a.limits} />
            <p className="mt-3 text-xs text-muted-foreground">{a.projects?.length ? t('hub.usedBy', { list: a.projects.join(', ') }) : t('hub.usedByNone')}</p>
          </Panel>
        ))}
      </div>
      {list.length > 1 && (
        <Panel testid="hub-switch" title={t('hub.projectAccount')} icon={FolderKanban}>
          {msg && <p className={cx('mb-2 text-sm', msg.ok ? 'text-success' : 'text-destructive')}>{msg.msg}</p>}
          <p className="mb-3 text-xs text-muted-foreground">{t('hub.projectAccountHint')}</p>
          <ul className="divide-y">
            {(projectsQ.data?.projects || []).map((p) => (
              <li key={p.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate font-medium">{p.name}</span>
                <select aria-label={t('hub.projectAccount')} data-testid="hub-account-select" value={p.account} disabled={busy === p.name}
                  onChange={(e) => switchTo(p.name, e.target.value)} className="min-h-10 rounded-xl border bg-background px-2">
                  {list.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
                </select>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Usage
const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
function Stat({ label, value, sub }) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}
const tokensOf = (b) => (b ? (b.in || 0) + (b.out || 0) + (b.cacheW || 0) + (b.cacheR || 0) : 0)
function UsageSection() {
  const { data, error, loading } = useLoad(() => api.usage(), [])
  const [from, setFrom] = useState(daysAgo(6))
  const [to, setTo] = useState(today())
  const rep = useLoad(() => api.report(from, to), [from, to])
  const u = data?.usage
  const days = u?.dailyArr || []
  const max = Math.max(1e-9, ...days.map((d) => d.cost || 0))
  const byProject = Object.entries(rep.data?.usage?.byProject || {}).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0))
  const api_ = data?.limits?.api
  return (
    <div className="space-y-4">
      <ErrorLine error={error} />
      {loading && !u && <Spinner />}
      {u && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={t('hub.today')} value={fmtUsd(u.today?.cost || 0)} sub={t('hub.messages', { n: fmtInt(u.today?.messages || 0) })} />
            <Stat label={t('hub.last30')} value={fmtUsd(days.reduce((s, d) => s + (d.cost || 0), 0))} sub={fmtTok(days.reduce((s, d) => s + tokensOf(d), 0)) + ' tokens'} />
            <Stat label={t('hub.allTime')} value={fmtUsd(u.total?.cost || 0)} sub={fmtTok(tokensOf(u.total)) + ' tokens'} />
            {api_?.configured ? <Stat label={t('hub.apiSpend')} value={fmtUsd(api_.month || 0)} sub={t('hub.apiToday', { v: fmtUsd(api_.today || 0) })} /> : <Stat label={t('hub.projectsCount')} value={fmtInt(Object.keys(u.byProject || {}).length)} />}
          </div>
          <Panel title={t('hub.costPerDay')} icon={BarChart3}>
            <p className="-mt-2 mb-3 text-xs text-muted-foreground">{t('hub.costNote')}</p>
            <div className="flex h-32 items-end gap-[3px]" data-testid="hub-usage-chart">
              {days.map((d) => (
                <div key={d.date} className="group relative flex h-full flex-1 items-end" title={`${d.date}: ${fmtUsd(d.cost || 0)}`}>
                  <div className="w-full rounded-t bg-brand/80 group-hover:bg-brand" style={{ height: `${Math.max(2, ((d.cost || 0) / max) * 100)}%` }} />
                </div>
              ))}
            </div>
            {days.length > 0 && <div className="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>{days[0].date}</span><span>{days[days.length - 1].date}</span></div>}
          </Panel>
        </>
      )}
      <Panel title={t('hub.report')} icon={FolderKanban}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label={t('hub.from')} className="min-h-10 rounded-xl border bg-background px-2" />
          <span className="text-muted-foreground">→</span>
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label={t('hub.to')} className="min-h-10 rounded-xl border bg-background px-2" />
          {rep.loading && <Spinner />}
          {rep.data && <span className="ml-auto font-mono font-semibold">{fmtUsd(rep.data.usage.total.cost || 0)}</span>}
        </div>
        <ErrorLine error={rep.error} />
        {rep.data && (byProject.length === 0 ? <p className="text-sm text-muted-foreground">{t('hub.noUsage')}</p> : (
          <ul className="divide-y text-sm" data-testid="hub-report">
            {byProject.map(([name, b]) => (
              <li key={name} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 truncate">{name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{t('hub.messages', { n: fmtInt(b.messages || 0) })} · {fmtTok(tokensOf(b))}</span>
                <span className="w-24 shrink-0 text-right font-mono">{fmtUsd(b.cost || 0)}</span>
              </li>
            ))}
          </ul>
        ))}
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------- Server
function ServerSection() {
  const { data: h, error, loading, reload } = useLoad(() => api.server(), [], 15000)
  const cg = h?.cgroupMem?.max ? h.cgroupMem : null // container memory limit, when there is one
  const disk = h?.disk
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ErrorLine error={error} />
        <Btn className="ml-auto" onClick={reload}>{loading ? <Spinner /> : <RefreshCw className="size-4" />} {t('hub.refresh')}</Btn>
      </div>
      {h && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="CPU" value={`${Math.round(h.cpu?.pct || 0)}%`} sub={t('hub.cores', { n: h.cpus, load: (h.load || []).join(' · ') })} />
            <Stat label={t('hub.memory')} value={`${cg ? cg.pct : h.mem?.pct ?? 0}%`} sub={cg ? `${fmtSize(cg.current)} / ${fmtSize(cg.max)}` : `${fmtSize(h.mem?.used)} / ${fmtSize(h.mem?.total)}`} />
            <Stat label={t('hub.disk')} value={disk ? `${disk.pct}%` : '—'} sub={disk ? `${fmtSize(disk.used)} / ${fmtSize(disk.total)}` : ''} />
            <Stat label={t('hub.uptime')} value={fmtUptime(h.uptime)} sub={h.hostname} />
          </div>
          <Panel title={t('hub.software')} icon={Cpu}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Claude Code</dt>
              <dd className="font-mono">{h.claude?.currentNum || h.claude?.current || '—'}{h.claude?.updateAvailable ? <span className="ml-2 text-xs text-amber-600 dark:text-amber-300">{t('hub.updateTo', { v: h.claude.latest })}</span> : null}</dd>
              <dt className="text-muted-foreground">Node</dt><dd className="font-mono">{h.node}</dd>
              <dt className="text-muted-foreground">{t('hub.panel')}</dt><dd className="font-mono">{fmtUptime(h.panel?.uptime)} · {fmtSize(h.panel?.rss)}</dd>
              <dt className="text-muted-foreground">tmux</dt><dd className="break-words font-mono text-xs">{(h.tmuxSessions || []).join(' · ') || '—'}</dd>
            </dl>
          </Panel>
          {Array.isArray(h.top) && h.top.length > 0 && (
            <Panel title={t('hub.topProcs')} icon={MemoryStick}>
              <ul className="divide-y text-sm">
                {h.top.slice(0, 8).map((p, i) => (
                  <li key={p.pid || i} className="flex items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{p.comm}</span>
                    <span className="w-14 shrink-0 text-right font-mono text-xs">{p.pcpu}%</span>
                    <span className="w-20 shrink-0 text-right font-mono text-xs">{fmtSize(p.rss)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Links
function LinksSection({ links, reload }) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null) // { id, label }
  const run = async (p) => { setBusy(true); const r = await p.catch((e) => ({ ok: false, msg: e.message })); setBusy(false); if (!r.ok) setMsg(r); else setMsg(null); reload(); return r }
  const add = async (e) => {
    e.preventDefault()
    const r = await run(api.addLink(label.trim(), url.trim()))
    if (r.ok) { setLabel(''); setUrl('') }
  }
  const kindOf = (u) => { const l = parseLink(u); return !l ? 'other' : l.kind }
  return (
    <div className="space-y-4">
      <Panel title={t('hub.addLink')} icon={Plus}>
        <p className="-mt-1 mb-3 text-xs text-muted-foreground">{t('hub.addLinkHint')}</p>
        <form onSubmit={add} className="grid gap-2 lg:grid-cols-[1fr_2fr_auto]">
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder={t('hub.linkName')} data-testid="hub-link-label" className="min-h-11 min-w-0 rounded-xl border bg-background px-3" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://…/remote?key=…" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-testid="hub-link-url" className="min-h-11 min-w-0 rounded-xl border bg-background px-3 font-mono" />
          <Btn type="submit" variant="brand" disabled={busy || !url.trim()} testid="hub-link-add"><Plus className="size-4" /> {t('hub.add')}</Btn>
        </form>
        {msg && !msg.ok && <p className="mt-2 text-sm text-destructive">{msg.msg}</p>}
      </Panel>
      <Panel title={t('hub.savedLinks')} icon={Link2}>
        {!(links || []).length ? <p className="text-sm text-muted-foreground">{t('hub.noLinks')}</p> : (
          <ul className="divide-y" data-testid="hub-links">
            {links.map((l, i) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2 py-2" data-testid="hub-link">
                <span className="min-w-0 flex-1">
                  {editing?.id === l.id ? (
                    <form className="flex gap-1" onSubmit={async (e) => { e.preventDefault(); await run(api.editLink(l.id, editing.label)); setEditing(null) }}>
                      <input autoFocus value={editing.label} maxLength={60} onChange={(e) => setEditing({ ...editing, label: e.target.value })} className="min-h-10 min-w-0 flex-1 rounded-xl border bg-background px-2" />
                      <Btn type="submit" variant="ghost" title={t('hub.save')}><Check className="size-4" /></Btn>
                      <Btn variant="ghost" onClick={() => setEditing(null)} title={t('hub.cancel')}><X className="size-4" /></Btn>
                    </form>
                  ) : (
                    <>
                      <span className="block truncate font-medium">{l.label || t(`hub.kind.${kindOf(l.url)}`)}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{t(`hub.kind.${kindOf(l.url)}`)} · {(() => { try { return new URL(l.url).host } catch { return '' } })()}</span>
                    </>
                  )}
                </span>
                {editing?.id !== l.id && (
                  <span className="flex shrink-0 items-center">
                    <a href={l.url} className="inline-flex size-10 items-center justify-center rounded-xl hover:bg-accent" title={t('hub.open')}><ExternalLink className="size-4" /></a>
                    <Btn variant="ghost" onClick={() => setEditing({ id: l.id, label: l.label })} title={t('hub.rename')}><Pencil className="size-4" /></Btn>
                    <Btn variant="ghost" disabled={i === 0 || busy} onClick={() => run(api.moveLink(l.id, 'up'))} title={t('hub.up')}><ArrowUp className="size-4" /></Btn>
                    <Btn variant="ghost" disabled={i === links.length - 1 || busy} onClick={() => run(api.moveLink(l.id, 'down'))} title={t('hub.down')}><ArrowDown className="size-4" /></Btn>
                    <Btn variant="danger" disabled={busy} onClick={() => run(api.removeLink(l.id))} title={t('hub.remove')} testid="hub-link-remove"><Trash2 className="size-4" /></Btn>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------- shell
function Blocked({ kind, onRetry }) {
  return (
    <div data-testid="hub-blocked" className="hub-top hub-bottom flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-muted text-muted-foreground"><KeyRound className="size-8" /></span>
      <div className="text-base font-medium">{kind === 'invalid' ? t('chat.invalidLink') : t('chat.offline')}</div>
      <div className="text-sm text-muted-foreground">{kind === 'invalid' ? t('hub.invalidHint') : t('chat.offlineHint')}</div>
      {kind !== 'invalid' && <button type="button" onClick={onRetry} className="mt-2 min-h-11 rounded-full border px-6 hover:bg-accent">{t('chat.retry')}</button>}
    </div>
  )
}

export default function App() {
  const [me, setMe] = useState(null)
  const [status, setStatus] = useState(hubKey() ? 'loading' : 'invalid')
  const [section, setSection] = useState(() => parseSection(location.hash))
  const links = useLoad(() => (hubKey() ? api.links().then((r) => r.links) : Promise.resolve([])), [])
  const acc = useLoad(() => (hubKey() ? api.accounts() : Promise.resolve(null)), [], 60000)

  const loadMe = useCallback(() => {
    if (!hubKey()) return
    setStatus('loading')
    api.me().then((r) => { setMe(r); setStatus('ok') }).catch((e) => setStatus(e instanceof ApiError && (e.status === 401 || e.status === 404) ? 'invalid' : 'error'))
  }, [])
  useEffect(loadMe, [loadMe])
  useEffect(() => {
    const on = () => setSection(parseSection(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // the key travels in the manifest's start_url: the home-screen app opens with it
  useEffect(() => {
    if (!hubKey() || document.querySelector('link[rel="manifest"]')) return
    const l = document.createElement('link')
    l.rel = 'manifest'
    l.href = `/remote/manifest.webmanifest?key=${encodeURIComponent(hubKey())}`
    document.head.appendChild(l)
  }, [])
  const go = (id) => { if (id !== section) { location.hash = '/' + id; setSection(id) } }

  if (status !== 'ok') return (
    <div className="hub-app h-full bg-background">
      {status === 'loading' ? <div className="flex h-full items-center justify-center"><Spinner /></div> : <Blocked kind={status} onRetry={loadMe} />}
    </div>
  )
  const accounts = acc.data?.accounts
  const title = t(`hub.sec.${section}`)
  return (
    <div className="hub-app flex h-full bg-background text-foreground">
      <nav className="hub-top hidden w-60 shrink-0 flex-col border-r bg-sidebar p-3 lg:flex" aria-label={t('hub.menu')}>
        <div className="mb-4 px-2 pt-2">
          <div className="text-base font-semibold">Claude Remote</div>
          <div className="truncate text-xs text-muted-foreground">{t('hub.hello', { name: me.label })}</div>
        </div>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => go(s.id)} data-testid={`hub-nav-${s.id}`} aria-current={section === s.id ? 'page' : undefined}
            className={cx('mb-0.5 flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm transition-colors', section === s.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60')}>
            <s.icon className="size-4" /> {t(`hub.sec.${s.id}`)}
          </button>
        ))}
        <div className="mt-auto px-2 text-[11px] text-muted-foreground">{me.server?.name} · v{me.server?.version}</div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="hub-top shrink-0 border-b bg-background/90 backdrop-blur lg:border-b-0">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 lg:h-16 lg:px-8">
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold" data-testid="hub-title">{title}</h1>
            <span className="truncate text-xs text-muted-foreground lg:hidden">{me.label}</span>
          </div>
        </header>
        <main className="hub-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-4 py-4 lg:px-8 lg:py-6">
            {section === 'projects' && <ProjectsSection links={links.data} accounts={accounts} />}
            {section === 'accounts' && <AccountsSection acc={acc} />}
            {section === 'usage' && <UsageSection />}
            {section === 'server' && <ServerSection />}
            {section === 'links' && <LinksSection links={links.data} reload={links.reload} />}
          </div>
        </main>
        <nav className="hub-bottom shrink-0 border-t bg-background/95 backdrop-blur lg:hidden" aria-label={t('hub.menu')}>
          <div className="grid grid-cols-5">
            {SECTIONS.map((s) => (
              <button key={s.id} type="button" onClick={() => go(s.id)} data-testid={`hub-tab-${s.id}`} aria-current={section === s.id ? 'page' : undefined}
                className={cx('flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px]', section === s.id ? 'text-foreground' : 'text-muted-foreground')}>
                <s.icon className={cx('size-5', section === s.id && 'text-brand')} />
                <span className="max-w-full truncate px-1">{t(`hub.sec.${s.id}`)}</span>
              </button>
            ))}
          </div>
        </nav>
      </div>
    </div>
  )
}
