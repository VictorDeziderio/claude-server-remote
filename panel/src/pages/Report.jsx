import { useEffect, useState, useCallback } from 'react'
import { BarChart3, MessageSquare, Layers, Database, TrendingUp, Loader2, CalendarRange, DollarSign, Info } from 'lucide-react'
import { Card, Empty, inputCls } from '../components/ui.jsx'
import { fmtTok, fmtInt, fmtUsd, shortModel } from '../lib/format.js'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'
import { TR } from '../lib/i18n-rich.jsx'

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function periodRange(key) {
  const now = new Date()
  const y = now.getFullYear(),
    m = now.getMonth()
  const today = ymd(now)
  switch (key) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const d = new Date(now)
      d.setDate(d.getDate() - 1)
      const s = ymd(d)
      return { from: s, to: s }
    }
    case 'week': {
      const d = new Date(now)
      const dow = (d.getDay() + 6) % 7
      d.setDate(d.getDate() - dow)
      return { from: ymd(d), to: today }
    }
    case 'month':
      return { from: ymd(new Date(y, m, 1)), to: today }
    case 'lastmonth':
      return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) }
    case 'year':
      return { from: `${y}-01-01`, to: today }
    case 'lastyear':
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }
    default:
      return { from: '', to: '' }
  }
}
const PERIODS = [
  ['today', 'period.today'],
  ['yesterday', 'period.yesterday'],
  ['week', 'period.week'],
  ['month', 'period.month'],
  ['lastmonth', 'period.lastmonth'],
  ['year', 'period.year'],
  ['lastyear', 'period.lastyear'],
  ['all', 'period.all'],
]

function Kpi({ icon: Icon, label, value, hint, hero }) {
  return (
    <div className="rounded-lg bg-card p-4 border">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Icon className="h-3.5 w-3.5 text-primary" /> {label}
      </div>
      <div className={`mt-1.5 font-mono text-foreground ${hero ? 'text-2xl font-semibold' : 'text-lg'}`}>{value}</div>
      {hint && <div className="mt-0.5 font-mono text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

// grafico de barras diario com eixo Y, ticks no X e tooltip
function DailyChart({ daily, metric }) {
  const [hover, setHover] = useState(null)
  const val = (d) => (metric === 'cost' ? d.cost || 0 : (d.in || 0) + (d.out || 0))
  const fmt = metric === 'cost' ? fmtUsd : fmtTok
  const max = Math.max(1e-9, ...daily.map(val))
  const ticks = [1, 0.75, 0.5, 0.25, 0]
  const xTicks = daily.length <= 8 ? daily.map((_, i) => i) : [0, Math.floor(daily.length / 4), Math.floor(daily.length / 2), Math.floor((3 * daily.length) / 4), daily.length - 1]
  return (
    <div className="relative">
      <div className="flex">
        <div className="flex w-14 shrink-0 flex-col justify-between pr-2 text-right font-mono text-xs text-muted-foreground/70" style={{ height: 176 }}>
          {ticks.map((t) => (
            <span key={t}>{fmt(max * t)}</span>
          ))}
        </div>
        <div className="relative flex-1">
          <div className="absolute inset-0 flex flex-col justify-between">
            {ticks.map((t) => (
              <div key={t} className="border-t border-border" />
            ))}
          </div>
          <div className="relative flex h-44 items-end gap-px">
            {daily.map((d, i) => {
              const v = val(d)
              const h = Math.max(2, Math.round((v / max) * 100))
              return (
                <div key={d.date} className="group relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  <div className={`w-full rounded-t transition ${hover === i ? 'bg-primary' : 'bg-primary/70'}`} style={{ height: h + '%' }} />
                </div>
              )
            })}
          </div>
          <div className="relative mt-1 h-4 font-mono text-xs text-muted-foreground/70">
            {xTicks.map(
              (i) =>
                daily[i] && (
                  <span key={i} className="absolute -translate-x-1/2" style={{ left: `${((i + 0.5) / daily.length) * 100}%` }}>
                    {daily[i].date.slice(5)}
                  </span>
                ),
            )}
          </div>
        </div>
      </div>
      {hover !== null && daily[hover] && (
        <div className="pointer-events-none absolute right-2 top-0 rounded-lg bg-background px-3 py-2 shadow-xl border">
          <div className="text-sm font-medium text-foreground">{daily[hover].date}</div>
          <div className="font-mono text-xs text-foreground">
            {fmtTok(daily[hover].in)} in · {fmtTok(daily[hover].out)} out
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {t('report.cacheLine', { w: fmtTok(daily[hover].cacheW), r: fmtTok(daily[hover].cacheR) })}
          </div>
          <div className="font-mono text-xs text-primary">
            {fmtUsd(daily[hover].cost)} · {fmtInt(daily[hover].messages)} msgs
          </div>
        </div>
      )}
    </div>
  )
}

export default function Report({ data }) {
  const [period, setPeriod] = useState('month')
  const [range, setRange] = useState(() => periodRange('month'))
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [usage, setUsage] = useState(data.usage || {})
  const [loading, setLoading] = useState(false)
  const [metric, setMetric] = useState('tokens')

  const load = useCallback(async (from, to) => {
    setLoading(true)
    try {
      const r = await api.report(from, to)
      if (r.ok) setUsage(r.usage)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load(range.from, range.to)
  }, [range, load])

  const pick = (key) => {
    setPeriod(key)
    if (key !== 'custom') setRange(periodRange(key))
  }
  const applyCustom = () => {
    if (custom.from && custom.to) {
      setPeriod('custom')
      setRange({ from: custom.from, to: custom.to })
    }
  }
  const pill = (active) => `rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${active ? 'bg-primary text-primary-foreground' : 'bg-accent text-foreground/80 border hover:bg-secondary'}`

  const u = usage || {}
  const byProject = Object.entries(u.byProject || {})
    .map(([name, v]) => ({ name, ...v, total: (v.in || 0) + (v.out || 0) }))
    .sort((a, b) => b.cost - a.cost)
  const byModel = Object.entries(u.byModel || {})
    .map(([model, v]) => ({ model, ...v, total: (v.in || 0) + (v.out || 0) }))
    .sort((a, b) => b.cost - a.cost)
  const daily = u.dailyArr || []
  const maxProj = Math.max(1e-9, ...byProject.map((p) => p.cost))
  const totalTokens = (u.total?.in || 0) + (u.total?.out || 0)
  const totalCache = (u.total?.cacheW || 0) + (u.total?.cacheR || 0)
  const unknown = u.unknownModels || []

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap gap-2">
          {PERIODS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => pick(k)} className={pill(period === k)}>
              {t(label)}
            </button>
          ))}
          <button type="button" onClick={() => setPeriod('custom')} className={`inline-flex items-center gap-1.5 ${pill(period === 'custom')}`}>
            <CalendarRange className="h-3.5 w-3.5" /> {t('period.custom')}
          </button>
          {loading && (
            <span className="inline-flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('common.loading')}
            </span>
          )}
        </div>
        {period === 'custom' && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground">
              {t('period.from')}
              <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={`mt-1 block ${inputCls}`} />
            </label>
            <label className="text-xs text-muted-foreground">
              {t('period.to')}
              <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={`mt-1 block ${inputCls}`} />
            </label>
            <button type="button" onClick={applyCustom} disabled={!custom.from || !custom.to} className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary disabled:opacity-40">
              {t('period.apply')}
            </button>
          </div>
        )}
        <div className="mt-2 font-mono text-xs text-muted-foreground">
          {t('period.label')} <code className="text-foreground/80">{range.from || t('period.start')}</code> → <code className="text-foreground/80">{range.to || t('period.now')}</code>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi icon={DollarSign} label={t('report.cost')} value={fmtUsd(u.total?.cost)} hint={t('report.costHint')} hero />
        <Kpi icon={BarChart3} label="Tokens (in+out)" value={fmtTok(totalTokens)} hint={`${fmtTok(u.total?.in)} in · ${fmtTok(u.total?.out)} out`} />
        <Kpi icon={Database} label={t('report.cache')} value={fmtTok(totalCache)} hint={t('report.cacheHint', { w: fmtTok(u.total?.cacheW), r: fmtTok(u.total?.cacheR) })} />
        <Kpi icon={MessageSquare} label={t('report.messages')} value={fmtInt(u.messages)} />
        <Kpi icon={Layers} label={t('report.days')} value={fmtInt(daily.length)} />
      </div>

      <Card
        title={t('report.daily', { what: metric === 'cost' ? t('report.dailyCost') : t('report.dailyTokens') })}
        subtitle={daily.length ? `${daily[0].date} → ${daily[daily.length - 1].date}` : ''}
        actions={
          <div className="flex gap-1">
            {[
              ['tokens', 'tokens'],
              ['cost', 'US$'],
            ].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setMetric(k)} className={`rounded-md px-2 py-0.5 text-[11px] ${metric === k ? 'bg-primary/20 text-primary' : 'bg-accent text-muted-foreground hover:text-primary-foreground'}`}>
                {l}
              </button>
            ))}
          </div>
        }
      >
        {daily.length === 0 ? <Empty>{t('report.noData')}</Empty> : <DailyChart daily={daily} metric={metric} />}
      </Card>

      <Card title={t('report.byModel')} subtitle={t('report.models', { n: byModel.length })}>
        {byModel.length === 0 ? (
          <Empty>{t('report.noData')}</Empty>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-accent text-[11px] text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t('col.model')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('col.in')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('col.out')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('col.cacheW')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('col.cacheR')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('col.msgs')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('col.cost')}</th>
                  </tr>
                </thead>
                <tbody className="text-foreground">
                  {byModel.map((m) => (
                    <tr key={m.model} className="border-t border-border">
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs">{shortModel(m.model)}</span>
                        {!m.known && (
                          <span className="ml-2 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-300" title={t('report.unknownTitle')}>
                            {t('report.unknown')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(m.in)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(m.out)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(m.cacheW)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(m.cacheR)}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtInt(m.messages)}</td>
                      <td className="px-3 py-2 text-right font-mono text-sm font-medium text-foreground">{fmtUsd(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" /> <span><TR k="report.estimateNote" />{unknown.length ? t('report.unknownModels', { list: unknown.map(shortModel).join(', ') }) : ''}</span>
            </p>
          </>
        )}
      </Card>

      <Card title={t('report.byProject')} subtitle={t('report.projects', { n: byProject.length })}>
        {byProject.length === 0 ? (
          <Empty>{t('report.noData')}</Empty>
        ) : (
          <div className="space-y-3">
            {byProject.map((p) => (
              <div key={p.name}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <TrendingUp className="h-3.5 w-3.5 text-primary" /> {p.name}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {fmtUsd(p.cost)} · {fmtTok(p.total)} · {fmtInt(p.messages)} msgs
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-background border">
                  <div className="h-full rounded-full bg-primary" style={{ width: Math.round((p.cost / maxProj) * 100) + '%' }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={t('report.detail')}>
        {byProject.length === 0 ? (
          <Empty>{t('report.noData')}</Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead className="bg-accent text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">{t('col.project')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('col.in')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('col.out')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('col.cacheW')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('col.cacheR')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('col.msgs')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('col.cost')}</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {byProject.map((p) => (
                  <tr key={p.name} className="border-t border-border">
                    <td className="px-3 py-2 text-sm text-foreground">{p.name}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(p.in)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(p.out)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(p.cacheW)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtTok(p.cacheR)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmtInt(p.messages)}</td>
                    <td className="px-3 py-2 text-right font-mono text-sm font-medium text-foreground">{fmtUsd(p.cost)}</td>
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
