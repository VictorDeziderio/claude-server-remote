// "Remote hub" card of Settings: the people who may open the hub (/remote?key=<their key>).
// Every person is an owner: the hub opens the chat of every project of this server and shows the
// accounts, usage and server data. The server keeps only a hash: the plain link is shown once.
import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Copy, Check, ExternalLink, Network } from 'lucide-react'
import { Btn, Card, Skeleton, inputCls, useConfirm } from './ui.jsx'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'
import { fmtIso } from '../lib/format.js'
import { copyText } from '../lib/clipboard.js'

export function HubPeopleCard({ onFlash }) {
  const [list, setList] = useState(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState(null) // { id, url } just created
  const [copied, setCopied] = useState('')
  const [confirmEl, ask] = useConfirm()
  const freshInput = useRef(null)
  const load = () => api.hubPeople().then(setList).catch(() => setList({ ok: false }))
  useEffect(() => { load() }, [])
  const create = async () => {
    if (!label.trim()) return onFlash?.({ ok: false, msg: t('hub.admin.needName') })
    setBusy(true)
    const r = await api.hubPersonCreate(label.trim()).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    if (!r.ok) return onFlash?.(r)
    setFresh({ id: r.id, url: r.url }); setCopied(''); setLabel('')
    load()
  }
  const revoke = async (p) => {
    if (!(await ask(t('hub.admin.revokeAsk', { label: p.label }), { yes: t('hub.admin.revoke'), danger: true }))) return
    const r = await api.hubPersonRevoke(p.id).catch((e) => ({ ok: false, msg: e.message }))
    if (!r.ok) onFlash?.(r)
    if (fresh?.id === p.id) setFresh(null)
    load()
  }
  const copy = async () => {
    if (await copyText(fresh.url)) return setCopied('ok')
    setCopied('fail')
    onFlash?.({ ok: false, msg: t('chatlink.copyFailed') })
    freshInput.current?.focus()
    freshInput.current?.select()
  }
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Network className="h-4 w-4" /> {t('hub.admin.title')}</span>} subtitle={t('hub.admin.sub')}>
      <div className="space-y-3 text-sm" data-testid="hub-people">
        <div className="flex flex-wrap items-center gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} maxLength={60} placeholder={t('hub.admin.name')} className={`min-w-0 flex-1 ${inputCls}`} data-testid="hub-person-label" />
          <Btn variant="accent" busy={busy} onClick={create}><Plus className="h-3.5 w-3.5" /> {t('hub.admin.create')}</Btn>
        </div>
        {fresh && (
          <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/10 p-2" data-testid="hub-person-fresh">
            <p className="text-foreground">{t('chatlink.copyOnce')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input ref={freshInput} readOnly value={fresh.url} onFocus={(e) => e.target.select()} data-testid="hub-person-url" className={`min-w-0 flex-1 font-mono text-xs ${inputCls}`} />
              <Btn onClick={copy}>{copied === 'ok' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === 'ok' ? t('chatlink.copied') : t('chatlink.copy')}</Btn>
              <a href={fresh.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" /> {t('chatlink.open')}</a>
            </div>
          </div>
        )}
        {!list ? <Skeleton className="h-10" /> : !list.ok ? <p className="text-destructive">{list.msg || t('chatlink.error')}</p> : list.people.length === 0 ? (
          <p className="text-muted-foreground">{t('hub.admin.none')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {list.people.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2" data-testid="hub-person">
                <span className="min-w-0 truncate">
                  <b>{p.label}</b>
                  <span className="text-xs text-muted-foreground"> · {t('chatlink.created', { date: fmtIso(p.createdAt) })} · {p.lastUsedAt ? t('chatlink.lastUsed', { date: fmtIso(p.lastUsedAt) }) : t('chatlink.never')} · {t('hub.admin.links', { n: p.links })}</span>
                </span>
                <Btn variant="ghost" onClick={() => revoke(p)}><Trash2 className="h-3.5 w-3.5" /> {t('hub.admin.revoke')}</Btn>
              </li>
            ))}
          </ul>
        )}
      </div>
      {confirmEl}
    </Card>
  )
}
