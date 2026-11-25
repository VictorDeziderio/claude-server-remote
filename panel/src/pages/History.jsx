import { useEffect, useState, useCallback } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { History, MessageSquare, Play, ArrowLeft, RefreshCw, Bot, User, Wrench, Loader2, Pin } from 'lucide-react'
import { Btn, Card, Empty, Skeleton, InlineConfirm } from '../components/ui.jsx'
import { fmtInt, fmtTok, fmtIso, shortModel } from '../lib/format.js'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'

// /history[/:name] — Claude conversations per project (read from the .jsonl files) + "continue" (claude --resume)
export default function HistoryPage({ data, onFlash, refresh }) {
  const { name } = useParams()
  const navigate = useNavigate()
  const projects = data?.projects || []
  const [list, setList] = useState(null)
  const [open, setOpen] = useState(null) // { id, conversation }
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState('')
  const proj = projects.find((p) => p.name === name)
  const pinnedId = proj?.pinnedSession

  const pin = async (id) => {
    setBusy('pin:' + id)
    const r = await api.setSessionMode(name, 'pinned', id).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    onFlash?.(r)
    if (r.ok) refresh?.()
  }

  const load = useCallback(async () => {
    if (!name) return
    setLoading(true)
    try {
      const r = await api.history(name)
      if (r.ok) setList(r.sessions)
      else onFlash?.(r)
    } catch (e) {
      onFlash?.({ ok: false, msg: e.message })
    } finally {
      setLoading(false)
    }
  }, [name, onFlash])
  useEffect(() => {
    setList(null)
    setOpen(null)
    load()
  }, [load])

  const view = async (id) => {
    setBusy('view:' + id)
    const r = await api.conversation(name, id).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    if (r.ok) setOpen({ id, conversation: r.conversation })
    else onFlash?.(r)
  }
  const resume = async (id) => {
    setBusy('resume:' + id)
    const r = await api.resumeConversation(name, id).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    setConfirm('')
    onFlash?.(r)
    if (r.ok) navigate('/terminal/' + encodeURIComponent(name))
  }

  if (!name) {
    return (
      <Card title={t('history.pick')}>
        {projects.length === 0 ? (
          <Empty>{t('projects.none')}</Empty>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.name} to={'/history/' + encodeURIComponent(p.name)} className="flex items-center gap-3 rounded-lg bg-muted/40 p-3 border transition hover:border-primary/30">
                <History className="h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{p.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{p.dir}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    )
  }

  if (open) {
    const c = open.conversation
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card p-4 border">
          <div className="flex min-w-0 items-center gap-2">
            <Btn variant="ghost" onClick={() => setOpen(null)}>
              <ArrowLeft className="h-3.5 w-3.5" /> {t('common.back')}
            </Btn>
            <h2 className="truncate text-sm font-medium text-foreground">{c.title}</h2>
            {pinnedId === open.id && <span className="rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[11px] text-primary">{t('history.pinned')}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground">
              {fmtInt(c.messages)} msgs · {fmtTok(c.tokens)} tokens · {shortModel(c.model)} · {fmtIso(c.first)} → {fmtIso(c.last)}
            </span>
            {pinnedId !== open.id && (
              <Btn size="sm" variant="ghost" busy={busy === 'pin:' + open.id} onClick={() => pin(open.id)} title={t('history.pinTitle')}>
                <Pin className="h-3.5 w-3.5" /> {t('history.pin')}
              </Btn>
            )}
            {confirm === open.id ? (
              <InlineConfirm danger={false} text={proj?.claudeRunning ? t('history.resumeRunning') : t('history.resumeShell')} onYes={() => resume(open.id)} onNo={() => setConfirm('')} busy={busy === 'resume:' + open.id} />
            ) : (
              <Btn variant="accent" onClick={() => setConfirm(open.id)}>
                <Play className="h-3.5 w-3.5" /> {t('history.continueThis')}
              </Btn>
            )}
          </div>
        </div>
        <div className="space-y-2">
          {c.items.map((m, i) => (
            <div key={i} className={`flex gap-3 rounded-xl p-3 ${m.role === 'user' ? 'border border-border bg-card' : 'bg-primary/5 ring-1 ring-primary/15'}`}>
              {m.role === 'user' ? <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : m.text.startsWith('[ferramenta') ? <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
              <div className="min-w-0 flex-1">
                <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground">{m.text}</pre>
                <div className="mt-1 font-mono text-xs text-muted-foreground/70">
                  {fmtIso(m.ts)}
                  {m.model ? ' · ' + shortModel(m.model) : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <Card
      title={t('history.title', { name })}
      subtitle={list ? t('history.count', { n: list.length }) : ''}
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/history" className="text-xs text-muted-foreground hover:text-foreground/80">
            {t('history.other')}
          </Link>
          <Btn size="sm" variant="ghost" onClick={load}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Btn>
        </div>
      }
    >
      {!list ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : list.length === 0 ? (
        <Empty>{t('history.empty')}</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-2.5 transition hover:bg-accent">
              <MessageSquare className="h-4 w-4 shrink-0 text-primary" />
              <button type="button" onClick={() => view(s.id)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-foreground hover:underline">{s.title}</span>
                  {pinnedId === s.id && <span className="shrink-0 rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[11px] text-primary">{t('history.pinned')}</span>}
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  {fmtIso(s.last)} · {fmtInt(s.messages)} msgs · {fmtTok(s.tokens)} tokens · {shortModel(s.model) || '?'} · <span className="text-muted-foreground/70">{s.id.slice(0, 8)}</span>
                </div>
              </button>
              {pinnedId !== s.id && (
                <Btn size="sm" variant="ghost" busy={busy === 'pin:' + s.id} onClick={() => pin(s.id)} title={t('history.pinTitle')}>
                  <Pin className="h-3.5 w-3.5" />
                </Btn>
              )}
              {confirm === s.id ? (
                <InlineConfirm danger={false} text={proj?.claudeRunning ? t('history.resumeRunning') : t('history.resumeShell')} onYes={() => resume(s.id)} onNo={() => setConfirm('')} busy={busy === 'resume:' + s.id} />
              ) : (
                <Btn size="sm" variant="accent" onClick={() => setConfirm(s.id)}>
                  <Play className="h-3.5 w-3.5" /> {t('history.continue')}
                </Btn>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
