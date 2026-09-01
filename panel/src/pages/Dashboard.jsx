import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Cpu, GitBranch, Radio, RefreshCw, Activity, Pencil, Plus, Power, Wifi, WifiOff,
  Lock, Save, UserRound, Tag, SquareTerminal, FolderOpen, Trash2,
} from 'lucide-react'
import { Dot, Btn, Chip, Modal, inputCls } from '../components/ui.jsx'
import { fmtInt, fmtTok } from '../lib/format.js'
import * as api from '../api.js'

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
function ProjStatus({ p }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
      <span className="inline-flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-slate-500" /> tmux <Dot on={p.up} /> {p.up ? 'de pé' : 'fora'}</span>
      <span className="inline-flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-slate-500" /> Claude <Dot on={p.claudeRunning} /> {p.claudeRunning ? 'rodando' : 'parado'}</span>
      <span className="inline-flex items-center gap-1.5"><Radio className="h-3.5 w-3.5 text-slate-500" /> remote {p.autoRemote ? <code className="text-slate-300">{p.remoteCmd}</code> : <span className="text-slate-500">desligado</span>}</span>
    </div>
  )
}

export default function Dashboard({ data, refresh, onFlash, showNew, setShowNew }) {
  const [busy, setBusy] = useState('')
  const [drafts, setDrafts] = useState({})
  const [editing, setEditing] = useState({})
  const [initDrafts, setInitDrafts] = useState({})
  const [form, setForm] = useState({ name: '', autoStartClaude: true, autoRemote: true })
  const [confirmDel, setConfirmDel] = useState(null) // { name, typed }

  const run = async (key, fn) => {
    setBusy(key)
    try { const r = await fn(); if (r && typeof r.ok === 'boolean') onFlash(r); return r }
    catch (e) { onFlash({ ok: false, msg: e.message }); return null }
    finally { setBusy(''); refresh() }
  }
  const startRename = (name) => {
    if (!window.confirm(`Renomear "${name}" vai RENOMEAR A PASTA no servidor e migrar o histórico do Claude. A sessão tmux será recriada.\n\nDesbloquear o campo para editar?`)) return
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
  const deleteNow = () => run(`delete:${confirmDel.name}`, async () => {
    const r = await api.deleteProject(confirmDel.name)
    if (r.ok) setConfirmDel(null)
    return r
  })

  const login = data.login || { logged: false, account: '' }
  const u = data.usage || { today: {}, total: {} }
  const projects = data.projects || []

  return (
    <>
      {/* Resumo */}
      <section className="mb-5 rounded-2xl bg-ink-800 p-4 ring-1 ring-white/5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatItem icon={UserRound} label="Conta Claude">
            <Link to="/account" className="inline-flex items-center gap-2 hover:underline"><Dot on={login.logged} /> {login.logged ? (login.account || 'logado') : 'deslogado — clique p/ logar'}</Link>
          </StatItem>
          <StatItem icon={Tag} label="Versão">{data.version || '?'}</StatItem>
          <StatItem icon={SquareTerminal} label="Terminal">
            <Link to="/terminal/shell" className="hover:underline">abrir shell em /root →</Link>
          </StatItem>
        </div>
        <div className="mt-4 border-t border-white/5 pt-4">
          <div className="mb-2 flex items-center justify-between">
            <Link to="/report" className="flex items-center gap-2 text-sm font-medium text-slate-200 hover:text-white"><GitBranch className="h-4 w-4 text-claude" /> Consumo de tokens</Link>
            <div className="text-xs text-slate-400">{u.sessions} sessões · {fmtInt(u.messages)} msgs</div>
          </div>
          <div className="overflow-x-auto rounded-xl ring-1 ring-white/5">
            <table className="w-full text-sm">
              <thead className="bg-ink-700/60 text-[11px] uppercase tracking-wide text-slate-400">
                <tr><th className="px-3 py-2 text-left font-medium"></th><th className="px-3 py-2 text-right font-medium">Entrada</th><th className="px-3 py-2 text-right font-medium">Saída</th><th className="px-3 py-2 text-right font-medium">Cache esc.</th><th className="px-3 py-2 text-right font-medium">Cache leit.</th></tr>
              </thead>
              <tbody className="text-slate-200">
                {[['Hoje', u.today], ['Total', u.total]].map(([label, row]) => (
                  <tr key={label} className="border-t border-white/5">
                    <td className="px-3 py-2 text-slate-400">{label}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(row?.in)}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(row?.out)}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(row?.cacheW)}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(row?.cacheR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Projetos */}
      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-slate-300">Projetos <span className="text-slate-500">({projects.length})</span></h2>
          {data.remoteNameForced
            ? <span className="text-[11px] text-slate-500">remote fixo: <code>/remote-control {data.remoteNameForced}</code></span>
            : <span className="text-[11px] text-slate-500">remote = nome do projeto</span>}
        </div>
        {projects.length === 0 && (
          <div className="rounded-2xl bg-ink-800 p-8 text-center text-sm text-slate-500 ring-1 ring-white/5">
            Nenhum projeto ainda. <button type="button" className="text-claude hover:underline" onClick={() => setShowNew(true)}>Criar o primeiro</button>.
          </div>
        )}
        {projects.map((p) => (
          <div key={p.name} className={`rounded-2xl bg-ink-800 p-4 ring-1 ${p.claudeRunning ? 'ring-claude/30' : 'ring-white/5'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><Dot on={p.up && p.claudeRunning} /><Link to={'/terminal/' + encodeURIComponent(p.name)} className="font-medium text-white hover:underline">{p.name}</Link></div>
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
                {p.remoteUrl && (
                  <a href={p.remoteUrl} target="_blank" rel="noreferrer" title="abre/reconecta o controle remoto — o link continua válido mesmo se você fechou a aba no PC"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500/90 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-sky-500">
                    <Radio className="h-3.5 w-3.5" /> Abrir remote
                  </a>
                )}
                <Btn variant="accent" busy={busy === `restart:${p.name}`} onClick={() => run(`restart:${p.name}`, () => api.restartProject(p.name))} title="mata a sessão tmux (fecha remote + Claude) → reabre o Claude → religa o remote → envia a primeira linha"><RefreshCw className="h-3.5 w-3.5" /> Reiniciar Claude</Btn>
                <Btn busy={busy === `remote:${p.name}`} onClick={() => run(`remote:${p.name}`, () => api.reconnectRemote(p.name))} title="re-emite o /remote-control sem reiniciar (preserva a conversa)"><Radio className="h-3.5 w-3.5" /> Religar remote</Btn>
                <Link to={'/terminal/' + encodeURIComponent(p.name)} className="inline-flex items-center gap-1.5 rounded-lg bg-ink-500 px-3 py-1.5 text-[13px] font-medium text-slate-100 transition hover:bg-ink-500/70"><SquareTerminal className="h-3.5 w-3.5" /> Terminal</Link>
                <Link to={'/files/projects/' + encodeURIComponent(p.name)} className="inline-flex items-center gap-1.5 rounded-lg bg-ink-500 px-3 py-1.5 text-[13px] font-medium text-slate-100 transition hover:bg-ink-500/70"><FolderOpen className="h-3.5 w-3.5" /> Arquivos</Link>
              </div>
            </div>

            {/* Primeira linha */}
            <div className="mt-3 border-t border-white/5 pt-3">
              <label className="text-xs text-slate-400">Primeira linha <span className="text-slate-600">— enviada ao Claude assim que ele fica pronto (todo início)</span></label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  value={initDrafts[p.name] ?? p.initLine ?? ''}
                  onChange={(e) => setInitDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') run(`init:${p.name}`, () => api.setInitLine(p.name, initDrafts[p.name] ?? p.initLine ?? '')) }}
                  placeholder="ex.: Você é o assistente da Empresa X. Cumprimente o cliente e ofereça ajuda."
                  className={`flex-1 ${inputCls}`}
                />
                <Btn variant="ghost" busy={busy === `init:${p.name}`} onClick={() => run(`init:${p.name}`, () => api.setInitLine(p.name, initDrafts[p.name] ?? p.initLine ?? ''))}>
                  <Save className="h-3.5 w-3.5" /> Salvar
                </Btn>
              </div>
            </div>

            {/* Renomear / excluir */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
              {editing[p.name] ? <Pencil className="h-3.5 w-3.5 text-claude" /> : <Lock className="h-3.5 w-3.5 text-slate-500" />}
              <input value={drafts[p.name] ?? p.name} onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))} disabled={!editing[p.name]} pattern="[A-Za-z0-9._-]{1,64}"
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(p.name); if (e.key === 'Escape') cancelRename(p.name) }}
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
              <Btn variant="danger" className="ml-auto" onClick={() => setConfirmDel({ name: p.name, typed: '' })}><Trash2 className="h-3.5 w-3.5" /> Excluir</Btn>
            </div>
          </div>
        ))}
      </section>

      {/* Modal: novo projeto */}
      {showNew && (
        <Modal title="Novo projeto" icon={Plus} onClose={() => setShowNew(false)}>
          <label className="mb-1 block text-xs text-slate-400">Nome do projeto</label>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') createNow() }} autoFocus placeholder="meu-projeto" pattern="[A-Za-z0-9._-]{1,64}"
            className={`w-full ${inputCls} px-3 py-2`} />
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
            <Btn variant="accent" busy={busy === 'create'} onClick={createNow} disabled={!form.name.trim()}><Power className="h-3.5 w-3.5" /> Criar projeto</Btn>
          </div>
          <p className="mt-3 text-xs text-slate-500">Cria a pasta em <code>{data.projectsDir}</code> + <code>git init</code> e sobe a sessão tmux do projeto.</p>
        </Modal>
      )}

      {/* Modal: excluir projeto (digitar o nome) */}
      {confirmDel && (
        <Modal title={`Excluir "${confirmDel.name}"`} icon={Trash2} onClose={() => setConfirmDel(null)}>
          <p className="text-sm text-slate-300">Isso <b>apaga a pasta</b> <code className="text-slate-200">{data.projectsDir}/{confirmDel.name}</code> no servidor e mata a sessão tmux. Não tem volta (o histórico de conversas do Claude é mantido).</p>
          <label className="mt-4 mb-1 block text-xs text-slate-400">Digite o nome do projeto para confirmar</label>
          <input value={confirmDel.typed} onChange={(e) => setConfirmDel((c) => ({ ...c, typed: e.target.value }))} autoFocus placeholder={confirmDel.name}
            onKeyDown={(e) => { if (e.key === 'Enter' && confirmDel.typed === confirmDel.name) deleteNow() }}
            className={`w-full ${inputCls} px-3 py-2`} />
          <div className="mt-5 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConfirmDel(null)}>Cancelar</Btn>
            <Btn variant="danger" busy={busy === `delete:${confirmDel.name}`} disabled={confirmDel.typed !== confirmDel.name} onClick={deleteNow}><Trash2 className="h-3.5 w-3.5" /> Excluir definitivamente</Btn>
          </div>
        </Modal>
      )}
    </>
  )
}
