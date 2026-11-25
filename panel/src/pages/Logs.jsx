import { useEffect, useState, useCallback, useRef } from 'react'
import { ScrollText, RefreshCw, Pause, Play, ArrowDownToLine, Loader2 } from 'lucide-react'
import { Btn, IconBtn, inputCls, Empty } from '../components/ui.jsx'
import { fmtSize, fmtDate } from '../lib/format.js'
import * as api from '../api.js'

// /logs — tail dos logs (painel, backup, auditoria) com auto-refresh e filtro
export default function LogsPage() {
  const [files, setFiles] = useState([])
  const [cur, setCur] = useState('panel')
  const [tail, setTail] = useState(null)
  const [auto, setAuto] = useState(true)
  const [filter, setFilter] = useState('')
  const [lines, setLines] = useState(300)
  const [loading, setLoading] = useState(false)
  const preRef = useRef(null)

  useEffect(() => {
    api
      .logs()
      .then((r) => {
        if (r.ok) setFiles(r.logs)
      })
      .catch(() => {})
  }, [tail])
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.logTail(cur, lines)
      if (r.ok) setTail(r)
    } finally {
      setLoading(false)
    }
  }, [cur, lines])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (!auto) return undefined
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [auto, load])
  useEffect(() => {
    if (preRef.current && auto) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [tail, auto])

  const shown = (tail?.lines || []).filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()))
  const colorOf = (l) => (/"level":"error"|WARN|ERR|falh|error/i.test(l) ? 'text-rose-600 dark:text-rose-300' : /login\.(ok|fail)|"action"/.test(l) ? 'text-sky-700 dark:text-sky-200' : /\bok\b/.test(l) ? 'text-emerald-700 dark:text-emerald-200' : 'text-foreground/80')
  // audit.log: JSON por linha -> mostra compacto
  const pretty = (l) => {
    if (cur !== 'audit') return l
    try {
      const o = JSON.parse(l)
      const { t, action, ip, ...rest } = o
      return `${t} ${action.padEnd(22)} ${ip || ''} ${Object.entries(rest)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')}`
    } catch {
      return l
    }
  }

  return (
    <div className="flex h-full min-h-[60vh] flex-col overflow-hidden rounded-lg bg-card border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          {files.map((f) => (
            <button key={f.key} type="button" onClick={() => setCur(f.key)} title={`${f.file} · ${fmtSize(f.size)} · ${fmtDate(f.mtime)}`} className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${cur === f.key ? 'bg-primary/15 text-primary ring-1 ring-primary/25' : 'bg-accent text-muted-foreground border hover:text-foreground'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filtrar…" className={`${inputCls} w-44`} />
        <select value={lines} onChange={(e) => setLines(parseInt(e.target.value, 10))} className={inputCls}>
          {[100, 300, 1000, 3000].map((n) => (
            <option key={n} value={n}>
              {n} linhas
            </option>
          ))}
        </select>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{tail ? `${shown.length}/${tail.total} linhas · ${fmtSize(tail.size)} · ${fmtDate(tail.mtime)}` : ''}</span>
        <IconBtn title={auto ? 'pausar auto-refresh' : 'retomar auto-refresh (5s)'} active={auto} onClick={() => setAuto((a) => !a)}>
          {auto ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </IconBtn>
        <IconBtn
          title="ir para o fim"
          onClick={() => {
            if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
          }}
        >
          <ArrowDownToLine className="h-4 w-4" />
        </IconBtn>
        <IconBtn title="atualizar" onClick={load}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </IconBtn>
      </div>
      <div ref={preRef} className="min-h-0 flex-1 overflow-auto bg-background">
        {!tail ? (
          <div className="flex h-full items-center justify-center">
            <span className="font-mono text-xs text-muted-foreground">carregando…</span>
          </div>
        ) : shown.length === 0 ? (
          <Empty>{tail.total === 0 ? 'log vazio (ainda não existe)' : 'nada bate com o filtro'}</Empty>
        ) : (
          <pre className="p-3 font-mono text-xs leading-relaxed">
            {shown.map((l, i) => (
              <div key={i} className={colorOf(l)}>
                {pretty(l)}
              </div>
            ))}
          </pre>
        )}
      </div>
      <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <ScrollText className="mr-1 inline h-3 w-3" /> arquivos em <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">~/.claude/logs/</code> · o log do container (start.sh/Caddy) fica no EasyPanel → Logs do serviço
      </p>
      <Btn className="hidden" />
    </div>
  )
}
