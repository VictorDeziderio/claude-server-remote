import { BarChart3, MessageSquare, Layers, Database, TrendingUp } from 'lucide-react'

const fmtTok = (n) => {
  n = n || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
const fmtInt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

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
const Empty = () => <div className="py-8 text-center text-sm text-slate-500">sem dados ainda</div>

export default function Report({ data }) {
  const u = data.usage || {}
  const byProject = Object.entries(u.byProject || {})
    .map(([name, v]) => ({ name, ...v, total: (v.in || 0) + (v.out || 0) }))
    .sort((a, b) => b.total - a.total)
  const daily = u.dailyArr || []
  const maxProj = Math.max(1, ...byProject.map((p) => p.total))
  const maxDay = Math.max(1, ...daily.map((d) => (d.in || 0) + (d.out || 0)))
  const totalTokens = (u.total?.in || 0) + (u.total?.out || 0)
  const totalCache = (u.total?.cacheW || 0) + (u.total?.cacheR || 0)
  const todayTokens = (u.today?.in || 0) + (u.today?.out || 0)

  return (
    <div className="space-y-5">
      {/* KPIs gerais */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={BarChart3} label="Tokens totais" value={fmtTok(totalTokens)} hint={`${fmtTok(todayTokens)} hoje`} />
        <Kpi icon={Database} label="Cache (esc+leit)" value={fmtTok(totalCache)} hint={`${fmtTok((u.total?.cacheR || 0))} de leitura`} />
        <Kpi icon={MessageSquare} label="Mensagens" value={fmtInt(u.messages)} />
        <Kpi icon={Layers} label="Sessões" value={fmtInt(u.sessions)} />
      </div>

      {/* Consumo diário */}
      <Card title="Consumo diário · entrada + saída" subtitle={daily.length ? `${daily[0].date} → ${daily[daily.length - 1].date}` : ''}>
        {daily.length === 0 ? <Empty /> : (
          <>
            <div className="flex h-44 items-end gap-1">
              {daily.map((d) => {
                const v = (d.in || 0) + (d.out || 0)
                const h = Math.max(2, Math.round((v / maxDay) * 100))
                return (
                  <div key={d.date} className="group relative flex-1" title={`${d.date}: ${fmtTok(v)}`}>
                    <div className="w-full rounded-t bg-claude/70 transition group-hover:bg-claude" style={{ height: h + '%' }} />
                  </div>
                )
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-slate-600">
              <span>{daily[0].date?.slice(5)}</span>
              <span>pico: {fmtTok(maxDay)}</span>
              <span>{daily[daily.length - 1].date?.slice(5)}</span>
            </div>
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
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-900 ring-1 ring-white/5">
                  <div className="h-full rounded-full bg-gradient-to-r from-claude-700 to-claude" style={{ width: Math.round((p.total / maxProj) * 100) + '%' }} />
                </div>
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
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Projeto</th>
                  <th className="px-3 py-2 text-right font-medium">Entrada</th>
                  <th className="px-3 py-2 text-right font-medium">Saída</th>
                  <th className="px-3 py-2 text-right font-medium">Cache esc.</th>
                  <th className="px-3 py-2 text-right font-medium">Cache leit.</th>
                  <th className="px-3 py-2 text-right font-medium">Msgs</th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {byProject.map((p) => (
                  <tr key={p.name} className="border-t border-white/5">
                    <td className="px-3 py-2 text-slate-200">{p.name}</td>
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
        <p className="mt-2 text-xs text-slate-500">Tokens são atribuídos ao projeto pela pasta de histórico do Claude (<code>~/.claude/projects</code>). Histórico de projetos já renomeados/excluídos não aparece aqui.</p>
      </Card>
    </div>
  )
}
