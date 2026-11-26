// Conversation info (like a contact's info screen): title, dates, counts and the tabs
// Media (3-column grid, tap = viewer) / Files (list) / Links (list). Each tab pages 30 at a time.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, Link2, MessagesSquare } from 'lucide-react'
import { api } from './api.js'
import { fmtFull, fmtWhen, hostOf, normLink } from './format.js'
import { FileRow, Thumb } from './media.jsx'
import { t } from '../lib/i18n.js'
import { Header, IconButton, Sentinel, Spinner, cx, toast } from './ui.jsx'

const TABS = ['media', 'files', 'links']
const tabLabel = (k) => (k === 'media' ? t('chat.tabMedia') : k === 'files' ? t('chat.tabFiles') : t('chat.tabLinks'))
const emptyText = (k) => (k === 'media' ? t('chat.noMedia') : k === 'files' ? t('chat.noFiles') : t('chat.noLinks'))
const fresh = () => ({ items: [], next: null, loaded: false, loading: false })

function TabBody({ tab, st, onView }) {
  if (!st.loaded && st.loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (st.loaded && !st.items.length) return <div data-testid="tab-empty" className="px-6 py-12 text-center text-sm text-muted-foreground">{emptyText(tab)}</div>
  if (tab === 'media') return (
    <div data-testid="media-grid" className="grid grid-cols-3 gap-0.5">
      {st.items.map((a, i) => <Thumb key={a.path || i} att={a} testid="media-item" onOpen={() => onView(a, st.items)} className="aspect-square w-full" />)}
    </div>
  )
  if (tab === 'files') return (
    <div data-testid="files-list" className="space-y-0.5 px-2 py-2">
      {st.items.map((a, i) => <FileRow key={a.path || i} att={a} sub={a.ts ? fmtWhen(a.ts) : ''} />)}
    </div>
  )
  return (
    <ul data-testid="links-list" className="px-2 py-2">
      {st.items.map((raw, i) => {
        const l = normLink(raw)
        return (
          <li key={l.url + i}>
            <a href={/^https?:\/\//i.test(l.url) ? l.url : undefined} target="_blank" rel="noopener noreferrer" data-testid="link-row"
              className="flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/60">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Link2 className="size-5" aria-hidden /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{l.title || hostOf(l.url) || l.url}</span>
                <span className="block truncate text-xs text-brand">{l.url}</span>
              </span>
            </a>
          </li>
        )
      })}
    </ul>
  )
}

export function Info({ id, item, meta, onBack, onView }) {
  const [tab, setTab] = useState('media')
  const [data, setData] = useState({ media: fresh(), files: fresh(), links: fresh() })
  const scroller = useRef(null)
  const busy = useRef({})

  const load = useCallback(async (k, before) => {
    if (busy.current[k]) return
    busy.current[k] = true
    setData((d) => ({ ...d, [k]: { ...d[k], loading: true } }))
    try {
      const r = await api.media(id, k, before)
      setData((d) => ({ ...d, [k]: { items: before ? [...d[k].items, ...(r.items || [])] : r.items || [], next: r.next || null, loaded: true, loading: false } }))
    } catch {
      toast(t('chat.loadFailed'))
      setData((d) => ({ ...d, [k]: { ...d[k], loaded: true, loading: false } }))
    } finally { busy.current[k] = false }
  }, [id])

  useEffect(() => { TABS.forEach((k) => load(k)) }, [load])

  const st = data[tab]
  const count = (k) => (data[k].loaded ? `${data[k].items.length}${data[k].next ? '+' : ''}` : '')
  const first = meta?.first
  const title = item?.title || meta?.firstUser?.slice(0, 80) || t('chat.untitled')

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="screen-info">
      <Header testid="info-header" left={<IconButton label={t('chat.back')} onClick={onBack} data-testid="info-back"><ChevronLeft className="size-7" /></IconButton>}>
        <div className="truncate text-[15px] font-semibold">{t('chat.info')}</div>
      </Header>
      <div ref={scroller} className="chat-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <section className="flex flex-col items-center gap-1 px-6 pb-5 pt-6 text-center">
          <span className="mb-2 grid size-20 place-items-center rounded-full bg-muted text-muted-foreground"><MessagesSquare className="size-9" /></span>
          <h1 data-testid="info-title" className="max-w-full break-words text-lg font-semibold [overflow-wrap:anywhere]">{title}</h1>
          {item?.messages != null && <div className="text-sm text-muted-foreground">{t('chat.messagesCount', { n: item.messages })}</div>}
          <dl className="mt-2 grid w-full max-w-sm grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-sm">
            {first && <><dt className="text-muted-foreground">{t('chat.started')}</dt><dd className="truncate text-right">{fmtFull(first)}</dd></>}
            {item?.updatedAt && <><dt className="text-muted-foreground">{t('chat.lastActivity')}</dt><dd className="truncate text-right">{fmtFull(item.updatedAt)}</dd></>}
          </dl>
        </section>
        <div role="tablist" className="chat-tabs sticky top-0 z-[2] grid grid-cols-3 border-b bg-background">
          {TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`tab-${k}`} onClick={() => setTab(k)}
              className={cx('relative min-h-11 px-2 text-sm font-medium transition-colors', tab === k ? 'text-foreground' : 'text-muted-foreground')}>
              {tabLabel(k)}{count(k) && <span className="ml-1 text-xs tabular-nums text-muted-foreground">{count(k)}</span>}
              {tab === k && <span aria-hidden className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-brand" />}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="pb-[env(safe-area-inset-bottom)]">
          <TabBody tab={tab} st={st} onView={onView} />
          <Sentinel enabled={st.loaded && !!st.next && !st.loading} onHit={() => load(tab, st.next)} rootRef={scroller} testid="info-sentinel" />
          {st.loaded && st.loading && <div className="flex justify-center py-4"><Spinner /></div>}
        </div>
      </div>
    </div>
  )
}
