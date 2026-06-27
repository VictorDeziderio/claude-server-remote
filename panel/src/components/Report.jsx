import { useEffect, useState, useCallback } from 'react'
import { BarChart3, MessageSquare, Layers, Database, TrendingUp, Loader2, CalendarRange } from 'lucide-react'
import * as api from '../api.js'

const fmtTok = (n) => {
  n = n || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
const fmtInt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function periodRange(key) {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth()
  const today = ymd(now)
  switch (key) {
    case 'today': return { from: today, to: today }
    case 'yesterday': { const d = new Date(now); d.setDate(d.getDate() - 1); const s = ymd(d); return { from: s, to: s } }
    case 'week': { const d = new Date(now); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return { from: ymd(d), to: today } }
    case 'month': return { from: ymd(new Date(y, m, 1)), to: today }
    case 'lastmonth': return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) }
    case 'year': return { from: `${y}-01-01`, to: today }
    case 'lastyear': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }
    default: return { from: '', to: '' }
  }
}
const PERIODS = [
  ['today', 'Hoje'], ['yesterday', 'Ontem'], ['week', 'Esta semana'],
  ['month', 'Este mês'], ['lastmonth', 'Mês passado'],
  ['year', 'Este ano'], ['lastyear', 'Ano passado'],
]

function Kpi({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-2xl bg-ink-800 p-4 ring-1 ring-white/5">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-400"><Icon className="h-3.5 w-3.5 text-claude" /> {label}</div>
      <div className="mt-1.5 text-2xl font-semibold text-white">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  )
}
function Card({ title, subtitle, children }) {
  return (
    <section className="rounded-2xl bg-ink-800 p-4 ring-1 ring-white/5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
        {subtitle && <span className="text-xs text-slate-500">{subtitle}</span>}
      </div>
      {children}
    </section>
  )
}
const Empty = () => <div className="py-8 text-center text-sm text-slate-500">sem dados no período</div>

export default function Report({ data }) {
  const [period, setPeriod] = useState('month')
  const [range, setRange] = useState(() => periodRange('month'))
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [usage, setUsage] = useState(data.usage || {})
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (from, to) => {
    setLoading(true)
    try { const r = await api.report(from, to); if (r.ok) setUsage(r.usage) } finally { setLoading(false) }
  }, [])
  useEffect(() => { load(range.from, range.to) }, [range, load])

  const pick = (key) => { setPeriod(key); if (key !== 'custom') setRange(periodRange(key)) }
  const applyCustom = () => { if (custom.from && custom.to) { setPeriod('custom'); setRange({ from: custom.from, to: custom.to }) } }

  const u = usage || {}
  const byProject = Object.entries(u.byProject || {})
    .map(([name, v]) => ({ name, ...v, total: (v.in || 0) + (v.out || 0) }))
    .sort((a, b) => b.total - a.total)
  const daily = u.dailyArr || []
  const maxProj = Math.max(1, ...byProject.map((p) => p.total))
  const maxDay = Math.max(1, ...daily.map((d) => (d.in || 0) + (d.out || 0)))
  const totalTokens = (u.total?.in || 0) + (u.total?.out || 0)
  const totalCache = (u.total?.cacheW || 0) + (u.total?.cacheR || 0)

  return (
    <div className="space-y-5">
      {/* Seletor de período */}
      <div className="rounded-2xl bg-ink-800 p-4 ring-1 ring-white/5">
        <div className="flex flex-wrap gap-2">
          {PERIODS.map(([k, label]) => (
            <button key={k} onClick={() => pick(k)}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${period === k ? 'bg-claude/90 text-white' : 'bg-ink-700/60 text-slate-300 ring-1 ring-white/5 hover:bg-ink-500'}`}>
              {label}
            </button>
          ))}
          <button onClick={() => setPeriod('custom')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${period === 'custom' ? 'bg-claude/90 text-white' : 'bg-ink-700/60 text-slate-300 ring-1 ring-white/5 hover:bg-ink-500'}`}>
            <CalendarRange className="h-3.5 w-3.5" /> Personalizado
          </button>
          {loading && <span className="inline-flex items-center gap-1.5 px-2 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> carregando…</span>}
        </div>
        {period === 'custom' && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-400">De
              <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                className="mt-1 block rounded-lg bg-ink-900 px-2.5 py-1.5 text-sm text-slate-200 ring-1 ring-white/10 focus:outline-none focus:ring-claude/40" /></label>
            <label className="text-xs text-slate-400">Até
              <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                className="mt-1 block rounded-lg bg-ink-900 px-2.5 py-1.5 text-sm text-slate-200 ring-1 ring-white/10 focus:outline-none focus:ring-claude/40" /></label>
            <button onClick={applyCustom} disabled={!custom.from || !custom.to}
              className="rounded-lg bg-claude/90 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-claude disabled:opacity-40">Aplicar</button>
          </div>
        )}
        <div className="mt-2 text-xs text-slate-500">período: <code className="text-slate-300">{range.from || 'início'}</code> → <code className="text-slate-300">{range.to || 'hoje'}</code></div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={BarChart3} label="Tokens (in+out)" value={fmtTok(totalTokens)} />
        <Kpi icon={Database} label="Cache (esc+leit)" value={fmtTok(totalCache)} />
        <Kpi icon={MessageSquare} label="Mensagens" value={fmtInt(u.messages)} />
        <Kpi icon={Layers} label="Dias com uso" value={fmtInt(daily.length)} />
      </div>

      {/* Consumo diário */}
      <Card title="Consumo diário · entrada + saída" subtitle={daily.length ? `${daily[0].date} → ${daily[daily.length - 1].date}` : ''}>
        {daily.length === 0 ? <Empty /> : (
          <>
            <div className="flex h-44 items-end gap-px">
              {daily.map((d) => {
                const v = (d.in || 0) + (d.out || 0)
                const h = Math.max(2, Math.round((v / maxDay) * 100))
                return <div key={d.date} className="group relative flex-1" title={`${d.date}: ${fmtTok(v)}`}><div className="w-full rounded-t bg-claude/70 transition group-hover:bg-claude" style={{ height: h + '%' }} /></div>
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-600"><span>{daily[0].date?.slice(5)}</span><span>pico/dia: {fmtTok(maxDay)}</span><span>{daily[daily.length - 1].date?.slice(5)}</span></div>
          </>
        )}
      </Card>

      {/* Tokens por projeto */}
      <Card title="Tokens por projeto" subtitle={`${byProject.length} projeto(s)`}>
        {byProject.length === 0 ? <Empty /> : (
          <div className="space-y-3">
            {byProject.map((p) => (
              <div key={p.name}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-1.5 text-slate-200"><TrendingUp className="h-3.5 w-3.5 text-claude" /> {p.name}</span>
                  <span className="text-slate-400">{fmtTok(p.total)} · {fmtInt(p.messages)} msgs</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-900 ring-1 ring-white/5"><div className="h-full rounded-full bg-gradient-to-r from-claude-700 to-claude" style={{ width: Math.round((p.total / maxProj) * 100) + '%' }} /></div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Detalhe por projeto */}
      <Card title="Detalhe por projeto">
        {byProject.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto rounded-xl ring-1 ring-white/5">
            <table className="w-full text-sm">
              <thead className="bg-ink-700/60 text-[11px] uppercase tracking-wide text-slate-400">
                <tr><th className="px-3 py-2 text-left font-medium">Projeto</th><th className="px-3 py-2 text-right font-medium">Entrada</th><th className="px-3 py-2 text-right font-medium">Saída</th><th className="px-3 py-2 text-right font-medium">Cache esc.</th><th className="px-3 py-2 text-right font-medium">Cache leit.</th><th className="px-3 py-2 text-right font-medium">Msgs</th></tr>
              </thead>
              <tbody className="text-slate-200">
                {byProject.map((p) => (
                  <tr key={p.name} className="border-t border-white/5">
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(p.in)}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(p.out)}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(p.cacheW)}</td>
                    <td className="px-3 py-2 text-right">{fmtTok(p.cacheR)}</td>
                    <td className="px-3 py-2 text-right">{fmtInt(p.messages)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
