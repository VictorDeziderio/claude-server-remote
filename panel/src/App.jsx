import { useEffect, useState, useCallback } from 'react'
import {
  Cpu, GitBranch, Radio, RefreshCw, Activity,
  Pencil, Plus, Power, Wifi, WifiOff, Check, X, Loader2, LogOut,
  Lock, Save, UserRound, Tag, LayoutDashboard, FolderTree, SquareTerminal, FolderOpen, BarChart3,
} from 'lucide-react'
import Logo from './components/Logo.jsx'
import Login from './components/Login.jsx'
import Files from './components/Files.jsx'
import TerminalView from './components/Terminal.jsx'
import Report from './components/Report.jsx'
import Account from './components/Account.jsx'
import * as api from './api.js'

const fmtInt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const fmtTok = (n) => {
  n = n || 0
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function Dot({ on }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${on ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,.5)]' : 'bg-rose-500'}`} />
}
function StatItem({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-ink-700/60 p-3 ring-1 ring-white/5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-claude" />
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
        <div className="truncate text-sm text-slate-100">{children}</div>
      </div>
    </div>
  )
}
function Btn({ onClick, busy, children, variant = 'default' }) {
  const cls = {
    default: 'bg-ink-500 hover:bg-ink-500/70 text-slate-100',
    accent: 'bg-claude/90 hover:bg-claude text-white',
    ghost: 'bg-transparent hover:bg-white/5 text-slate-300 ring-1 ring-white/10',
  }[variant]
  return (
    <button onClick={onClick} disabled={busy} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${cls} disabled:opacity-50`}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  )
}
function Chip({ on, onClick, busy, labelOn, labelOff, Icon }) {
  return (
    <button onClick={onClick} disabled={busy} title="clique para alternar"
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${
        on ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30' : 'bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/25'}`}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {on ? labelOn : labelOff}
    </button>
  )
}
function ProjStatus({ p }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
      <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-slate-500" /> tmux <Dot on={p.up} /> {p.up ? 'de pé' : 'fora'}</span>
      <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-slate-500" /> Claude <Dot on={p.claudeRunning} /> {p.claudeRunning ? 'rodando' : 'parado'}</span>
      <span className="inline-flex items-center gap-1.5"><Radio className="h-3.5 w-3.5 text-slate-500" /> remote {p.autoRemote ? <code className="text-slate-300">{p.remoteCmd}</code> : <span className="text-slate-500">desligado</span>}</span>
    </div>
  )
}
function NavItem({ icon: Icon, label, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
        active ? 'bg-claude/15 text-claude ring-1 ring-claude/25' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}>
      <Icon className="h-4 w-4" /> {label}
    </button>
  )
}

export default function App() {
  const [data, setData] = useState(null)
  const [authed, setAuthed] = useState(true)
  const [flash, setFlash] = useState(null)
  const [busy, setBusy] = useState('')
  const [drafts, setDrafts] = useState({})
  const [editing, setEditing] = useState({})
  const [initDrafts, setInitDrafts] = useState({}) // "primeira linha" por projeto
  const [form, setForm] = useState({ name: '', autoStartClaude: true, autoRemote: true })
  const [view, setView] = useState('dashboard')   // dashboard | report | files | terminal
  const [filesPath, setFilesPath] = useState('')
  const [termName, setTermName] = useState('')
  const [showNew, setShowNew] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const d = await api.getState()
      if (d && d.__unauth) { setAuthed(false); return }
      setAuthed(true)
      setData(d)
      setDrafts((prev) => {
        const next = { ...prev }
        for (const p of d.projects || []) if (next[p.name] === undefined) next[p.name] = p.name
        return next
      })
      setInitDrafts((prev) => {
        const next = { ...prev }
        for (const p of d.projects || []) if (next[p.name] === undefined) next[p.name] = p.initLine || ''
        return next
      })
    } catch (e) {
      setFlash({ ok: false, msg: 'falha ao carregar estado: ' + e.message })
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => { if (flash) { const t = setTimeout(() => setFlash(null), 6000); return () => clearTimeout(t) } }, [flash])

  const doLogout = async () => { try { await api.logout() } catch { /* */ } setData(null); setAuthed(false) }

  if (!authed) return <Login onSuccess={() => { setAuthed(true); refresh() }} />

  const run = async (key, fn) => {
    setBusy(key)
    try { const r = await fn(); if (r && typeof r.ok === 'boolean') setFlash(r) }
    catch (e) { setFlash({ ok: false, msg: e.message }) }
    finally { setBusy(''); refresh() }
  }
  const startRename = (name) => {
    const ok = window.confirm(
      `Renomear "${name}" vai RENOMEAR A PASTA no servidor e migrar o histórico do Claude. A sessão tmux será recriada.\n\nDesbloquear o campo para editar?`)
    if (!ok) return
    setDrafts((d) => ({ ...d, [name]: name })); setEditing((e) => ({ ...e, [name]: true }))
  }
  const cancelRename = (name) => { setEditing((e) => ({ ...e, [name]: false })); setDrafts((d) => ({ ...d, [name]: name })) }
  const commitRename = (name) => run(`rename:${name}`, async () => {
    const r = await api.renameProject(name, (drafts[name] || '').trim())
    if (r.ok) setEditing((e) => ({ ...e, [name]: false }))
    return r
  })
  const createNow = () => run('create', async () => {
    const r = await api.createProject(form.name.trim(), form.autoStartClaude, form.autoRemote)
    if (r.ok) { setForm({ name: '', autoStartClaude: true, autoRemote: true }); setShowNew(false) }
    return r
  })

  if (!data) {
    return <div className="flex h-full items-center justify-center text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin text-claude" /> carregando…</div>
  }

  const login = data.login || { logged: false, account: '' }
  const u = data.usage || { today: {}, total: {} }
  const titles = { dashboard: 'Dashboard', report: 'Relatório', files: 'Arquivos', terminal: 'Terminal', account: 'Conta' }

  const openFiles = (p) => { setFilesPath(p); setView('files') }
  const openTerm = (name) => { setTermName(name); setView('terminal') }

  return (
    <div className="flex min-h-full">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-white/5 bg-ink-900/40 p-4 sm:flex">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-ink-700 ring-1 ring-claude/30"><Logo size={22} /></div>
          <div className="text-sm font-semibold text-white">Claude <span className="text-claude">Remote</span></div>
        </div>
        <nav className="space-y-1">
          <NavItem icon={LayoutDashboard} label="Dashboard" active={view === 'dashboard'} onClick={() => setView('dashboard')} />
          <NavItem icon={BarChart3} label="Relatório" active={view === 'report'} onClick={() => setView('report')} />
          <NavItem icon={FolderTree} label="Arquivos" active={view === 'files'} onClick={() => openFiles('')} />
          <NavItem icon={SquareTerminal} label="Terminal" active={view === 'terminal'} onClick={() => setView('terminal')} />
          <NavItem icon={UserRound} label="Conta" active={view === 'account'} onClick={() => setView('account')} />
        </nav>
        <div className="mt-auto space-y-2 pt-4">
          <div className="rounded-xl bg-ink-800 p-3 ring-1 ring-white/5">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">conta</div>
            <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-300"><Dot on={login.logged} /> {login.logged ? (login.account || 'logado') : 'deslogado'}</div>
          </div>
          <button onClick={doLogout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/5 hover:text-slate-200"><LogOut className="h-4 w-4" /> sair</button>
        </div>
      </aside>

      {/* Conteúdo */}
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
        {/* Nav mobile */}
        <div className="mb-4 flex gap-2 overflow-x-auto sm:hidden">
          {[['dashboard', LayoutDashboard], ['report', BarChart3], ['files', FolderTree], ['terminal', SquareTerminal], ['account', UserRound]].map(([v, Ic]) => (
            <button key={v} onClick={() => (v === 'files' ? openFiles('') : setView(v))}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium ${view === v ? 'bg-claude/15 text-claude ring-1 ring-claude/25' : 'bg-ink-800 text-slate-400'}`}>
              <Ic className="h-4 w-4" /> {titles[v]}
            </button>
          ))}
        </div>

        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-white">{titles[view]}</h1>
          <div className="flex items-center gap-2">
            {view === 'dashboard' && <Btn variant="accent" onClick={() => setShowNew(true)}><Plus className="h-3.5 w-3.5" /> Novo projeto</Btn>}
            <Btn variant="ghost" onClick={refresh}><RefreshCw className="h-3.5 w-3.5" /> atualizar</Btn>
          </div>
        </div>

        {flash && (
          <div className={`mb-5 flex items-start gap-2 rounded-xl px-4 py-3 text-sm ring-1 ${flash.ok ? 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/25' : 'bg-rose-500/10 text-rose-200 ring-rose-500/25'}`}>
            {flash.ok ? <Check className="mt-0.5 h-4 w-4" /> : <X className="mt-0.5 h-4 w-4" />}<span>{flash.msg}</span>
          </div>
        )}

        {view === 'report' && <Report data={data} />}
        {view === 'account' && <Account data={data} onFlash={setFlash} refresh={refresh} />}
        {view === 'files' && <Files key={filesPath} initialPath={filesPath} onFlash={setFlash} />}
        {view === 'terminal' && <TerminalView projects={data.projects} initialName={termName} onFlash={setFlash} />}

        {view === 'dashboard' && (
          <>
            {/* Resumo */}
            <section className="mb-5 rounded-2xl bg-ink-800 p-4 ring-1 ring-white/5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <StatItem icon={UserRound} label="Conta Claude">
                  {login.logged ? <span className="inline-flex items-center gap-2"><Dot on /> {login.account || 'logado'}</span> : <span className="inline-flex items-center gap-2"><Dot on={false} /> deslogado</span>}
                </StatItem>
                <StatItem icon={Tag} label="Versão">{data.version || '?'}</StatItem>
              </div>
              <div className="mt-4 border-t border-white/5 pt-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-200"><GitBranch className="h-4 w-4 text-claude" /> Consumo de tokens</div>
                  <div className="text-xs text-slate-400">{u.sessions} sessões · {fmtInt(u.messages)} msgs</div>
                </div>
                <div className="overflow-hidden rounded-xl ring-1 ring-white/5">
                  <table className="w-full text-sm">
                    <thead className="bg-ink-700/60 text-[11px] uppercase tracking-wide text-slate-400">
                      <tr><th className="px-3 py-2 text-left font-medium"></th><th className="px-3 py-2 text-right font-medium">Entrada</th><th className="px-3 py-2 text-right font-medium">Saída</th><th className="px-3 py-2 text-right font-medium">Cache esc.</th><th className="px-3 py-2 text-right font-medium">Cache leit.</th></tr>
                    </thead>
                    <tbody className="text-slate-200">
                      <tr className="border-t border-white/5"><td className="px-3 py-2 text-slate-400">Hoje</td><td className="px-3 py-2 text-right">{fmtTok(u.today?.in)}</td><td className="px-3 py-2 text-right">{fmtTok(u.today?.out)}</td><td className="px-3 py-2 text-right">{fmtTok(u.today?.cacheW)}</td><td className="px-3 py-2 text-right">{fmtTok(u.today?.cacheR)}</td></tr>
                      <tr className="border-t border-white/5"><td className="px-3 py-2 text-slate-400">Total</td><td className="px-3 py-2 text-right">{fmtTok(u.total?.in)}</td><td className="px-3 py-2 text-right">{fmtTok(u.total?.out)}</td><td className="px-3 py-2 text-right">{fmtTok(u.total?.cacheW)}</td><td className="px-3 py-2 text-right">{fmtTok(u.total?.cacheR)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* Projetos */}
            <section className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-semibold text-slate-300">Projetos</h2>
                {data.remoteNameForced
                  ? <span className="text-[11px] text-slate-500">remote fixo: <code>/remote-control {data.remoteNameForced}</code></span>
                  : <span className="text-[11px] text-slate-500">remote = nome do projeto</span>}
              </div>
              {(data.projects || []).length === 0 && <p className="px-1 text-sm text-slate-500">Nenhum projeto ainda. Crie um abaixo.</p>}
              {(data.projects || []).map((p) => (
                <div key={p.name} className={`rounded-2xl bg-ink-800 p-4 ring-1 ${p.claudeRunning ? 'ring-claude/30' : 'ring-white/5'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><Dot on={p.up && p.claudeRunning} /><span className="font-medium text-white">{p.name}</span></div>
                      <div className="mt-1 truncate text-xs text-slate-500">{p.dir}</div>
                      <ProjStatus p={p} />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Chip Icon={Cpu} on={p.autoStartClaude} busy={busy === `cfg:${p.name}:autoStartClaude`} labelOn="Claude: ON" labelOff="Claude: OFF"
                          onClick={() => run(`cfg:${p.name}:autoStartClaude`, () => api.setConfig(p.name, 'autoStartClaude', !p.autoStartClaude))} />
                        <Chip Icon={p.autoRemote ? Wifi : WifiOff} on={p.autoRemote} busy={busy === `cfg:${p.name}:autoRemote`} labelOn="Remote: ON" labelOff="Remote: OFF"
                          onClick={() => run(`cfg:${p.name}:autoRemote`, () => api.setConfig(p.name, 'autoRemote', !p.autoRemote))} />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Btn variant="accent" busy={busy === `restart:${p.name}`} onClick={() => run(`restart:${p.name}`, () => api.restartProject(p.name))} title="fecha o Claude (mesmo travado no remote), reabre e religa o remote"><RefreshCw className="h-3.5 w-3.5" /> Reiniciar Claude</Btn>
                      <Btn busy={busy === `remote:${p.name}`} onClick={() => run(`remote:${p.name}`, () => api.reconnectRemote(p.name))} title="re-emite o /remote-control sem reiniciar (preserva a conversa)"><Radio className="h-3.5 w-3.5" /> Religar remote</Btn>
                      <Btn onClick={() => openTerm(p.name)}><SquareTerminal className="h-3.5 w-3.5" /> Terminal</Btn>
                      <Btn onClick={() => openFiles('projects/' + p.name)}><FolderOpen className="h-3.5 w-3.5" /> Arquivos</Btn>
                    </div>
                  </div>

                  {/* Primeira linha — enviada ao Claude quando ele fica pronto */}
                  <div className="mt-3 border-t border-white/5 pt-3">
                    <label className="text-xs text-slate-400">Primeira linha <span className="text-slate-600">— enviada ao Claude assim que ele fica pronto (todo início)</span></label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        value={initDrafts[p.name] ?? p.initLine ?? ''}
                        onChange={(e) => setInitDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') run(`init:${p.name}`, () => api.setInitLine(p.name, initDrafts[p.name] ?? '')) }}
                        placeholder="ex.: Você é o assistente da Empresa X. Cumprimente o cliente e ofereça ajuda."
                        className="flex-1 rounded-lg bg-ink-900 px-2.5 py-1.5 text-sm text-slate-200 ring-1 ring-white/10 focus:outline-none focus:ring-claude/40"
                      />
                      <Btn variant="ghost" busy={busy === `init:${p.name}`} onClick={() => run(`init:${p.name}`, () => api.setInitLine(p.name, initDrafts[p.name] ?? ''))}>
                        <Save className="h-3.5 w-3.5" /> Salvar
                      </Btn>
                    </div>
                  </div>

                  {/* Renomear */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
                    {editing[p.name] ? <Pencil className="h-3.5 w-3.5 text-claude" /> : <Lock className="h-3.5 w-3.5 text-slate-500" />}
                    <input value={drafts[p.name] ?? p.name} onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))} disabled={!editing[p.name]} pattern="[A-Za-z0-9._-]{1,64}"
                      className={`w-44 rounded-lg px-2.5 py-1 text-sm ring-1 focus:outline-none ${editing[p.name] ? 'bg-ink-900 text-slate-200 ring-white/10 focus:ring-claude/40' : 'cursor-not-allowed bg-ink-900/50 text-slate-400 ring-white/5'}`} />
                    {editing[p.name] ? (
                      <>
                        <Btn variant="accent" busy={busy === `rename:${p.name}`} onClick={() => commitRename(p.name)}><Save className="h-3.5 w-3.5" /> Salvar</Btn>
                        <Btn variant="ghost" onClick={() => cancelRename(p.name)}>Cancelar</Btn>
                      </>
                    ) : (
                      <Btn variant="ghost" onClick={() => startRename(p.name)}><Lock className="h-3.5 w-3.5" /> Alterar</Btn>
                    )}
                    <span className="text-xs text-slate-600">{editing[p.name] ? '⚠ renomeia a pasta no servidor' : 'nome travado — clique em “Alterar”'}</span>
                  </div>
                </div>
              ))}
            </section>

          </>
        )}
      </main>

      {/* Modal: novo projeto (todos os serviços ativos por padrão) */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setShowNew(false)}>
          <div className="w-full max-w-md rounded-2xl bg-ink-800 p-5 shadow-2xl shadow-black/40 ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-white"><Plus className="h-4 w-4 text-claude" /> Novo projeto</div>
              <button onClick={() => setShowNew(false)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/5 hover:text-slate-200"><X className="h-4 w-4" /></button>
            </div>
            <label className="mb-1 block text-xs text-slate-400">Nome do projeto</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') createNow() }} autoFocus placeholder="meu-projeto" pattern="[A-Za-z0-9._-]{1,64}"
              className="w-full rounded-lg bg-ink-900 px-3 py-2 text-sm text-slate-200 ring-1 ring-white/10 focus:outline-none focus:ring-claude/40" />
            <div className="mt-4 space-y-2">
              <div className="text-xs text-slate-400">Serviços</div>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-ink-900 px-3 py-2 text-sm text-slate-200 ring-1 ring-white/5">
                <input type="checkbox" checked={form.autoStartClaude} onChange={(e) => setForm((f) => ({ ...f, autoStartClaude: e.target.checked }))} className="accent-[#D97757]" /><Cpu className="h-4 w-4 text-claude" /> Iniciar o Claude na sessão
              </label>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-ink-900 px-3 py-2 text-sm text-slate-200 ring-1 ring-white/5">
                <input type="checkbox" checked={form.autoRemote} onChange={(e) => setForm((f) => ({ ...f, autoRemote: e.target.checked }))} className="accent-[#D97757]" /><Radio className="h-4 w-4 text-claude" /> Religar o remote-control
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setShowNew(false)}>Cancelar</Btn>
              <Btn variant="accent" busy={busy === 'create'} onClick={createNow}><Power className="h-3.5 w-3.5" /> Criar projeto</Btn>
            </div>
            <p className="mt-3 text-xs text-slate-500">Cria a pasta em <code>{data.projectsDir}</code> + <code>git init</code> e sobe a sessão tmux do projeto.</p>
          </div>
        </div>
      )}
    </div>
  )
}
