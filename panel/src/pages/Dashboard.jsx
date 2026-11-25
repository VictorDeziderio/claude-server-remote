import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Cpu, Radio, RefreshCw, Activity, Plus, Power, Wifi, WifiOff, Save, UserRound, Tag, SquareTerminal, FolderOpen, Trash2, Settings2, History, DatabaseBackup, Pencil, HardDrive, MemoryStick, Gauge, Clock, ArrowUpCircle, CheckCircle2, ExternalLink, BarChart3, Pause, Play, ListTree, Pin } from 'lucide-react'
import { Dot, Btn, Chip, Modal, Drawer, ActivityBadge, inputCls, Skeleton } from '../components/ui.jsx'
import { fmtInt, fmtTok, fmtSize, fmtDate, fmtUsd, fmtUptime } from '../lib/format.js'
import * as api from '../api.js'
import { UsageWidget } from '../components/UsageLimits.jsx'

const SESSION_MODES = [
  ['new', 'Nova conversa'],
  ['continue', 'Continuar a última'],
  ['pinned', 'Sessão fixa'],
]

function StatItem({ icon: Icon, label, children, warn }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl border bg-accent p-3 ${warn ? 'border-amber-500/40' : 'border-border'}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? 'text-amber-300' : 'text-primary'}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="truncate text-sm text-slate-100">{children}</div>
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
        <span className="font-mono text-sm text-slate-300">{value}%</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-background">
        <div className={`h-full rounded-full ${pct(value)}`} style={{ width: Math.min(100, value) + '%' }} />
      </div>
      {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
    </div>
  )
}

// linha fina (sparkline) 0-100% para o historico de CPU/memoria — sem lib de grafico
function MiniLine({ points, color }) {
  if (!points || points.length < 2) return <div className="flex h-10 items-center text-[11px] text-slate-500">sem histórico ainda</div>
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
        <Meter icon={HardDrive} label="Disco (/root)" value={h.disk?.pct ?? 0} hint={h.disk ? `${fmtSize(h.disk.used)} de ${fmtSize(h.disk.total)} · livre ${fmtSize(h.disk.avail)}` : ''} />
        <Meter icon={MemoryStick} label="Memória" value={h.mem?.pct ?? 0} hint={h.mem ? `${fmtSize(h.mem.used)} de ${fmtSize(h.mem.total)}` : ''} />
        <Meter icon={Gauge} label="CPU" value={h.cpu?.pct ?? 0} hint={h.cpu?.cores ? `${h.cpu.cores} núcleo(s)` : ''} />
        <div className="rounded-xl bg-accent p-3 border">
          <div className="text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-primary" /> Load / CPUs
            </span>
          </div>
          <div className="mt-1 font-mono text-sm text-slate-100">
            {(h.load || []).join(' · ')} <span className="text-slate-500">/ {h.cpus}</span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            <Clock className="mr-1 inline h-3 w-3" />
            host há {fmtUptime(h.uptime)} · painel há {fmtUptime(h.panel?.uptime)}
          </div>
        </div>
        <div className={`rounded-xl border bg-accent p-3 ${c.updateAvailable ? 'border-amber-500/40' : 'border-border'}`}>
          <div className="text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5 text-primary" /> Claude Code
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-sm text-slate-100" title={c.current}>
            {c.currentNum || c.current || '?'}
            {c.latest && <span className="text-slate-500"> · npm {c.latest}</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            {c.updateAvailable ? (
              <Btn size="sm" variant="accent" busy={busy} onClick={update} title="npm i -g @anthropic-ai/claude-code@latest">
                <ArrowUpCircle className="h-3.5 w-3.5" /> Atualizar p/ {c.latest}
              </Btn>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" /> {c.latest ? 'atualizado' : 'sem acesso ao npm'}
              </span>
            )}
            {!compact && (
              <Link to="/account" className="text-[11px] text-slate-500 hover:text-slate-300">
                detalhes →
              </Link>
            )}
          </div>
        </div>
      </div>

      {!compact && (history.length > 0 || top.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {history.length > 0 && (
            <div className="rounded-xl bg-accent p-3 border">
              <div className="mb-1 text-[11px] text-muted-foreground">Últimas 6h</div>
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                <span className="inline-block h-1.5 w-3 rounded-full bg-sky-400" /> CPU
                <span className="ml-3 inline-block h-1.5 w-3 rounded-full bg-amber-400" /> Memória
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
                <ListTree className="h-3.5 w-3.5 text-primary" /> Top processos
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {top.slice(0, 5).map((p) => (
                    <tr key={p.pid} className="border-t border-white/5 first:border-0">
                      <td className="py-1 pr-2 text-slate-500">{p.pid}</td>
                      <td className="py-1 pr-2 truncate text-slate-200" title={p.comm}>{p.comm}</td>
                      <td className="py-1 pr-2 text-right font-mono text-slate-400">{(p.pcpu ?? 0).toFixed(0)}% cpu</td>
                      <td className="py-1 text-right font-mono text-slate-400">{fmtSize(p.rss)}</td>
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
    <>
      {/* Resumo */}
      <section className="mb-5 rounded-lg bg-card p-5 border">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatItem icon={UserRound} label="Conta Claude" warn={!login.logged}>
            <Link to={login.logged ? '/account' : '/account?login=1'} className="inline-flex items-center gap-2 hover:underline">
              <Dot on={login.logged} /> {login.logged ? login.account || 'logado' : 'deslogado — clique p/ logar'}
            </Link>
          </StatItem>
          <StatItem icon={Cpu} label="Sessões">
            <span className="font-mono text-sm text-slate-100">
              {running}/{projects.length}
            </span>{' '}
            com Claude rodando{off ? <span className="text-slate-500"> · {off} desligado(s)</span> : ''}
            {waiting ? <span className="text-rose-300"> · {waiting} aguardando você</span> : ''}
          </StatItem>
          <StatItem icon={BarChart3} label="Hoje">
            <Link to="/report" className="text-sm hover:underline">
              <span className="font-mono">{fmtTok((u.today?.in || 0) + (u.today?.out || 0))}</span> tokens · <span className="font-mono">{fmtUsd(u.today?.cost)}</span> · <span className="font-mono">{fmtInt(u.today?.messages)}</span> msgs
            </Link>
          </StatItem>
        </div>
        <div className="mt-4 border-t border-white/6 pt-4 empty:hidden">
          <UsageWidget />
        </div>
        <div className="mt-4 border-t border-white/6 pt-4">
          <HealthCard onFlash={onFlash} />
        </div>
      </section>

      {/* Projetos */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-medium text-slate-200">
            Projetos <span className="font-mono text-xs text-slate-500">({projects.length})</span>
          </h2>
          {data.remoteNameForced ? (
            <span className="text-[11px] text-slate-500">
              remote fixo: <code className="font-mono text-xs">/remote-control {data.remoteNameForced}</code>
            </span>
          ) : (
            <span className="text-[11px] text-slate-500">remote = nome do projeto</span>
          )}
        </div>
        {projects.length === 0 && (
          <div className="rounded-lg bg-card p-8 text-center text-sm text-slate-500 border">
            Nenhum projeto ainda.{' '}
            <button type="button" className="text-primary hover:underline" onClick={() => setShowNew(true)}>
              Criar o primeiro
            </button>
            .
          </div>
        )}
        {projects.map((p, idx) => {
          const act = actOf(p)
          const on = p.enabled !== false
          const accent = !on ? 'bg-white/10' : act === 'prompt' ? 'bg-rose-400 animate-pulse' : act === 'busy' ? 'bg-amber-400 animate-pulse' : p.claudeRunning ? 'bg-success/60' : 'bg-white/10'
          return (
            <div key={p.name} className={`relative animate-fade-up overflow-hidden rounded-lg bg-card p-5 border transition duration-200 hover:-translate-y-px hover:border-primary/30 ${!on ? 'opacity-70' : ''}`} style={{ animationDelay: `${idx * 40}ms` }}>
              <div className={`absolute inset-y-0 left-0 w-[3px] ${accent}`} />
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={'/terminal/' + encodeURIComponent(p.name)} className="text-base font-semibold text-white hover:underline">
                      {p.name}
                    </Link>
                    {!on ? <span className="rounded-full bg-slate-500/15 px-2 py-0.5 text-[11px] text-slate-400 border">desligado</span> : p.claudeRunning ? <ActivityBadge state={act} since={p.activitySince} /> : <ActivityBadge state="off" />}
                    {p.paused && <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300" title="Claude pausado por inatividade — não consome CPU/memória até retomar">Pausado</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1.5">
                      <Activity className="h-3.5 w-3.5 text-slate-500" /> tmux <Dot on={p.up} /> {p.up ? 'de pé' : 'fora'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Cpu className="h-3.5 w-3.5 text-slate-500" /> Claude <Dot on={p.claudeRunning} /> {p.claudeRunning ? 'rodando' : 'parado'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Radio className="h-3.5 w-3.5 text-slate-500" /> {p.autoRemote ? <code className="font-mono text-xs text-slate-300">{p.remoteCmd}</code> : <span className="text-slate-500">remote desligado</span>}
                    </span>
                    {p.initLine && (
                      <span className="truncate text-slate-500" title={p.initLine}>
                        1ª linha: “{p.initLine.slice(0, 60)}
                        {p.initLine.length > 60 ? '…' : ''}”
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Chip Icon={Power} on={on} busy={busy === `power:${p.name}`} labelOn="Ligado" labelOff="Desligado" onClick={() => run(`power:${p.name}`, () => api.setPower(p.name, !on))} />
                    <Chip Icon={Cpu} on={p.autoStartClaude} busy={busy === `cfg:${p.name}:autoStartClaude`} labelOn="Claude: ON" labelOff="Claude: OFF" onClick={() => run(`cfg:${p.name}:autoStartClaude`, () => api.setConfig(p.name, 'autoStartClaude', !p.autoStartClaude))} />
                    <Chip Icon={p.autoRemote ? Wifi : WifiOff} on={p.autoRemote} busy={busy === `cfg:${p.name}:autoRemote`} labelOn="Remote: ON" labelOff="Remote: OFF" onClick={() => run(`cfg:${p.name}:autoRemote`, () => api.setConfig(p.name, 'autoRemote', !p.autoRemote))} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {p.remoteUrl && (
                    <a href={p.remoteUrl} target="_blank" rel="noreferrer" title="abre/reconecta o controle remoto — o link continua válido mesmo se você fechou a aba no PC" className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/90 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-sky-500">
                      <ExternalLink className="h-3.5 w-3.5" /> Abrir remote
                    </a>
                  )}
                  <Link to={'/terminal/' + encodeURIComponent(p.name)} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-primary">
                    <SquareTerminal className="h-3.5 w-3.5" /> Terminal
                  </Link>
                  <Link to={'/files/projects/' + encodeURIComponent(p.name)} className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-[13px] font-medium text-slate-100 transition hover:bg-secondary/80">
                    <FolderOpen className="h-3.5 w-3.5" /> Arquivos
                  </Link>
                  <Btn busy={busy === `restart:${p.name}`} onClick={() => run(`restart:${p.name}`, () => api.restartProject(p.name))} title={on ? 'mata a sessão tmux (fecha remote + Claude) → reabre o Claude → religa o remote → envia a primeira linha' : 'liga o projeto e sobe a sessão'}>
                    <RefreshCw className="h-3.5 w-3.5" /> {on ? 'Reiniciar' : 'Ligar'}
                  </Btn>
                  {p.paused ? (
                    <Btn variant="accent" busy={busy === `unpause:${p.name}`} onClick={() => run(`unpause:${p.name}`, () => api.unpauseProject(p.name))} title="retoma o Claude pausado">
                      <Play className="h-3.5 w-3.5" /> Retomar
                    </Btn>
                  ) : (
                    p.claudeRunning && (
                      <Btn variant="ghost" busy={busy === `pause:${p.name}`} onClick={() => run(`pause:${p.name}`, () => api.pauseProject(p.name))} title="pausa o Claude desta sessão — libera CPU/memória até você retomar">
                        <Pause className="h-3.5 w-3.5" /> Pausar
                      </Btn>
                    )
                  )}
                  <Btn variant="ghost" onClick={() => setDrawer(p.name)} title="configurar: primeira linha, renomear, histórico, backup, excluir">
                    <Settings2 className="h-3.5 w-3.5" />
                  </Btn>
                </div>
              </div>
            </div>
          )
        })}
      </section>

      {drawerProj && <ProjectDrawer p={drawerProj} data={data} busy={busy} run={run} onClose={() => setDrawer(null)} />}

      {/* Modal: novo projeto */}
      {showNew && (
        <Modal title="Novo projeto" icon={Plus} onClose={() => setShowNew(false)}>
          <label className="mb-1 block text-xs text-slate-400">Nome do projeto</label>
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
            <div className="text-xs text-slate-400">Serviços</div>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm text-slate-200 border">
              <input type="checkbox" checked={form.autoStartClaude} onChange={(e) => setForm((f) => ({ ...f, autoStartClaude: e.target.checked }))} className="accent-[#D97757]" />
              <Cpu className="h-4 w-4 text-primary" /> Iniciar o Claude na sessão
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-background px-3 py-2 text-sm text-slate-200 border">
              <input type="checkbox" checked={form.autoRemote} onChange={(e) => setForm((f) => ({ ...f, autoRemote: e.target.checked }))} className="accent-[#D97757]" />
              <Radio className="h-4 w-4 text-primary" /> Religar o remote-control
            </label>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setShowNew(false)}>
              Cancelar
            </Btn>
            <Btn variant="accent" busy={busy === 'create'} onClick={createNow} disabled={!form.name.trim()}>
              <Power className="h-3.5 w-3.5" /> Criar projeto
            </Btn>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Cria a pasta em <code>{data.projectsDir}</code> + <code>git init</code> e sobe a sessão tmux do projeto.
          </p>
        </Modal>
      )}
    </>
  )
}

// Drawer "Configurar projeto": primeira linha, remote, renomear, historico, backup, excluir
function ProjectDrawer({ p, data, busy, run, onClose }) {
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
    <Drawer title={`Configurar “${p.name}”`} icon={Settings2} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-xs text-slate-500">
          {p.dir} · sessão <code className="font-mono text-xs">{p.session}</code>
        </div>

        <Section title="Primeira linha" icon={Pencil}>
          <p className="mb-2 text-xs text-slate-500">Enviada ao Claude assim que ele fica pronto, em todo início (como prompt inicial).</p>
          <div className="flex items-center gap-2">
            <input
              value={initLine}
              onChange={(e) => setInitLine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run(`init:${p.name}`, () => api.setInitLine(p.name, initLine))
              }}
              placeholder="ex.: Você é o assistente da Empresa X. Cumprimente o cliente e ofereça ajuda."
              className={`flex-1 ${inputCls}`}
            />
            <Btn variant="accent" busy={busy === `init:${p.name}`} onClick={() => run(`init:${p.name}`, () => api.setInitLine(p.name, initLine))}>
              <Save className="h-3.5 w-3.5" />
            </Btn>
          </div>
        </Section>

        <Section title="Ao reiniciar o Claude" icon={Pin}>
          <p className="mb-2 text-xs text-slate-500">O que acontece com a conversa quando o Claude é religado nesta sessão (reiniciar, ligar, ou religar remote).</p>
          <select value={p.sessionMode || 'new'} onChange={(e) => run(`sessmode:${p.name}`, () => api.setSessionMode(p.name, e.target.value))} className={inputCls}>
            {SESSION_MODES.map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          {(p.sessionMode || 'new') === 'pinned' && (
            <p className="mt-2 text-xs text-slate-500">
              {p.pinnedSession ? (
                <>
                  sessão fixada: <code className="font-mono text-xs text-slate-300">{String(p.pinnedSession).slice(0, 8)}</code> · trocar em{' '}
                </>
              ) : (
                <>nenhuma conversa fixada ainda — escolha uma em </>
              )}
              <Link to={'/history/' + encodeURIComponent(p.name)} onClick={onClose} className="text-primary hover:underline">
                Histórico
              </Link>
            </p>
          )}
        </Section>

        <Section title="Controle remoto" icon={Radio}>
          <div className="flex flex-wrap items-center gap-2">
            <Btn busy={busy === `remote:${p.name}`} onClick={() => run(`remote:${p.name}`, () => api.reconnectRemote(p.name))} title="re-emite o /remote-control sem reiniciar (preserva a conversa)">
              <Radio className="h-3.5 w-3.5" /> Religar remote
            </Btn>
            {p.remoteUrl && (
              <a href={p.remoteUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/90 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-sky-500">
                <ExternalLink className="h-3.5 w-3.5" /> Abrir link
              </a>
            )}
            <span className="text-xs text-slate-500">
              comando: <code className="font-mono text-xs">{p.remoteCmd}</code>
            </span>
          </div>
        </Section>

        <Section title="Histórico de conversas" icon={History}>
          <Link to={'/history/' + encodeURIComponent(p.name)} onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-[13px] font-medium text-slate-100 hover:bg-secondary/80">
            <History className="h-3.5 w-3.5" /> Ver conversas / continuar
          </Link>
        </Section>

        <Section title="Backup (git)" icon={DatabaseBackup}>
          <div className="mb-2 text-xs text-slate-400">
            {bk === null ? (
              'carregando…'
            ) : !bk?.git ? (
              'esta pasta não é um repositório git'
            ) : !bk.origin ? (
              'sem remote origin — o backup automático ignora este projeto'
            ) : bk.last ? (
              <>
                último: <span className={bk.last.level === 'ok' ? 'text-emerald-300' : 'text-amber-300'}>{bk.last.level}</span> em {bk.last.ts} — {bk.last.msg}
              </>
            ) : (
              'ainda sem backup registrado'
            )}
            {bk?.dirty ? <span className="text-amber-300"> · {bk.dirty} arquivo(s) alterado(s) sem commit</span> : null}
          </div>
          <Btn busy={busy === `backup:${p.name}`} onClick={() => run(`backup:${p.name}`, () => api.backupRun(p.name))}>
            <DatabaseBackup className="h-3.5 w-3.5" /> Fazer backup agora
          </Btn>
        </Section>

        <Section title="Renomear" icon={Pencil}>
          <p className="mb-2 text-xs text-slate-500">
            Renomeia a <b>pasta no servidor</b>, migra o histórico do Claude e recria a sessão tmux (a conversa atual é encerrada).
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
                <Save className="h-3.5 w-3.5" /> Salvar
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => {
                  setRenaming(false)
                  setNewName(p.name)
                }}
              >
                Cancelar
              </Btn>
            </div>
          ) : (
            <Btn variant="ghost" onClick={() => setRenaming(true)}>
              <Pencil className="h-3.5 w-3.5" /> Alterar nome
            </Btn>
          )}
        </Section>

        <Section title="Excluir projeto" icon={Trash2} danger>
          <p className="mb-2 text-xs text-slate-400">
            Apaga{' '}
            <code className="font-mono text-xs text-slate-300">
              {data.projectsDir}/{p.name}
            </code>{' '}
            e mata a sessão. Sem volta (o histórico de conversas é mantido). Digite o nome para confirmar:
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
              <Trash2 className="h-3.5 w-3.5" /> Excluir definitivamente
            </Btn>
          </div>
        </Section>
      </div>
    </Drawer>
  )
}
