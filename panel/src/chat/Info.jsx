// Info of the project chat (like a contact's info screen): project, current conversation,
// notifications of this device, and the tabs Media (3-column grid, tap = viewer) / Files / Links
// of the conversation, 30 at a time. On a phone it is a screen of its own (back button); on a
// desktop it is the right sidebar next to the conversation (embedded).
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, BellOff, BellRing, ChevronLeft, Link2 } from 'lucide-react'
import { api } from './api.js'
import { fmtWhen, hostOf, normLink } from './format.js'
import { FileRow, Thumb } from './media.jsx'
import { t } from '../lib/i18n.js'
import { Header, IconButton, Sentinel, Spinner, cx, toast } from './ui.jsx'

const TABS = ['media', 'files', 'links']
const tabLabel = (k) => (k === 'media' ? t('chat.tabMedia') : k === 'files' ? t('chat.tabFiles') : t('chat.tabLinks'))
const emptyText = (k) => (k === 'media' ? t('chat.noMedia') : k === 'files' ? t('chat.noFiles') : t('chat.noLinks'))
const fresh = () => ({ items: [], next: null, loaded: false, loading: false })
const initial = (s) => (String(s || '').trim()[0] || '#').toUpperCase()

// what the notification control says in each state (src/chat/push.js)
export const PUSH_TEXT = {
  checking: 'chat.notifyChecking', off: 'chat.notifyOffHint', on: 'chat.notifyOnHint', install: 'chat.notifyInstall',
  denied: 'chat.notifyDenied', unsupported: 'chat.notifyUnsupported',
}

// header bell: turns notifications on with one tap; in the other states it explains
export function NotifyBell({ push, onExplain }) {
  const { state, busy, turnOn } = push
  const Icon = state === 'on' ? BellRing : state === 'off' || state === 'checking' ? Bell : BellOff
  const tap = async () => {
    if (state === 'off') { const r = await turnOn(); toast(t(r.ok ? 'chat.notifyTurnedOn' : PUSH_TEXT[r.state] || 'chat.notifyFailed')); return }
    if (onExplain) onExplain()
    else toast(t(PUSH_TEXT[state] || 'chat.notifyUnsupported'))
  }
  return (
    <IconButton label={state === 'on' ? t('chat.notifyOn') : t('chat.notifyTurnOn')} data-testid="notify-btn" data-state={state} disabled={busy || state === 'checking'} onClick={tap} variant={state === 'on' ? 'ghost' : 'muted'}>
      {busy ? <Spinner /> : <Icon className={cx('size-5', state === 'on' && 'text-brand')} />}
    </IconButton>
  )
}

function NotifySection({ push }) {
  const { state, busy, turnOn, turnOff } = push
  const act = async () => {
    const r = state === 'on' ? await turnOff() : await turnOn()
    if (!r.ok) toast(t(PUSH_TEXT[r.state] || 'chat.notifyFailed'))
  }
  const can = state === 'on' || state === 'off'
  return (
    <section data-testid="notify-section" data-state={state} className="mx-4 rounded-2xl border bg-card p-3">
      <div className="flex items-center gap-2 text-[15px] font-medium">
        {state === 'on' ? <BellRing className="size-4.5 text-brand" aria-hidden /> : <Bell className="size-4.5 text-muted-foreground" aria-hidden />}
        {t('chat.notifyTitle')}
        <span className={cx('ml-auto rounded-full px-2 py-0.5 text-xs', state === 'on' ? 'bg-brand/15 text-brand' : 'bg-muted text-muted-foreground')}>{state === 'on' ? t('chat.notifyStateOn') : t('chat.notifyStateOff')}</span>
      </div>
      <p data-testid="notify-hint" className="mt-1.5 text-sm text-muted-foreground">{t(PUSH_TEXT[state] || 'chat.notifyUnsupported')}</p>
      {can && (
        <button type="button" data-testid="notify-toggle" disabled={busy} onClick={act}
          className={cx('mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full px-4 text-[15px] font-medium transition-colors disabled:opacity-60',
            state === 'on' ? 'border hover:bg-accent' : 'bg-brand text-white hover:bg-brand/90')}>
          {busy && <Spinner className={cx('size-4', state !== 'on' && 'text-white')} />}
          {state === 'on' ? t('chat.notifyTurnOff') : t('chat.notifyTurnOn')}
        </button>
      )}
    </section>
  )
}

function TabBody({ tab, st, onView }) {
  if (!st.loaded && st.loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (st.loaded && !st.items.length) return <div data-testid="tab-empty" className="px-6 py-12 text-center text-sm text-muted-foreground">{emptyText(tab)}</div>
  if (tab === 'media') return (
    <div data-testid="media-grid" className="grid grid-cols-3 gap-0.5">
      {st.items.map((a, i) => <Thumb key={a.path || i} att={a} testid="media-item" onOpen={() => onView(a)} className="aspect-square w-full" />)}
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
              className="flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent/60">
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

export function Info({ me, st, push, embedded, onBack, onView }) {
  const [tab, setTab] = useState('media')
  const [data, setData] = useState({ media: fresh(), files: fresh(), links: fresh() })
  const scroller = useRef(null)
  const busy = useRef({})
  const conv = st?.conv || null

  const load = useCallback(async (k, before) => {
    if (busy.current[k]) return
    busy.current[k] = true
    setData((d) => ({ ...d, [k]: { ...(before ? d[k] : fresh()), loading: true } }))
    try {
      const r = await api.media(k, before)
      setData((d) => ({ ...d, [k]: { items: before ? [...d[k].items, ...(r.items || [])] : r.items || [], next: r.next || null, loaded: true, loading: false } }))
    } catch {
      toast(t('chat.loadFailed'))
      setData((d) => ({ ...d, [k]: { ...d[k], loaded: true, loading: false } }))
    } finally { busy.current[k] = false }
  }, [])

  // again for another conversation (the terminal Claude moved on)
  useEffect(() => { TABS.forEach((k) => load(k)) }, [load, conv])

  const cur = data[tab]
  const count = (k) => (data[k].loaded ? `${data[k].items.length}${data[k].next ? '+' : ''}` : '')

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={embedded ? 'info-sidebar' : 'screen-info'}>
      <Header testid="info-header" left={embedded ? null : <IconButton label={t('chat.back')} onClick={onBack} data-testid="info-back"><ChevronLeft className="size-7" /></IconButton>}>
        <div className={cx('truncate text-[15px] font-semibold', embedded && 'px-3')}>{t('chat.info')}</div>
      </Header>
      <div ref={scroller} className="chat-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <section className="flex flex-col items-center gap-1 px-6 pb-4 pt-6 text-center">
          <span aria-hidden className="mb-2 grid size-20 place-items-center rounded-full bg-brand/15 text-3xl font-semibold text-brand">{initial(me?.project)}</span>
          <h1 data-testid="info-title" className="max-w-full break-words text-lg font-semibold [overflow-wrap:anywhere]">{me?.project}</h1>
          <div className="text-sm text-muted-foreground">{t('chat.infoSub')}</div>
          {st?.title && <div data-testid="info-conv" className="mt-1 max-w-full truncate text-sm">{st.title}</div>}
        </section>
        <NotifySection push={push} />
        <div role="tablist" className="chat-tabs sticky top-0 z-[2] mt-4 grid grid-cols-3 border-b bg-background">
          {TABS.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} data-testid={`tab-${k}`} onClick={() => setTab(k)}
              className={cx('relative min-h-11 px-2 text-sm font-medium transition-colors hover:text-foreground', tab === k ? 'text-foreground' : 'text-muted-foreground')}>
              {tabLabel(k)}{count(k) && <span className="ml-1 text-xs tabular-nums text-muted-foreground">{count(k)}</span>}
              {tab === k && <span aria-hidden className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-brand" />}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="pb-[env(safe-area-inset-bottom)]">
          <TabBody tab={tab} st={cur} onView={onView} />
          <Sentinel enabled={cur.loaded && !!cur.next && !cur.loading} onHit={() => load(tab, cur.next)} rootRef={scroller} testid="info-sentinel" />
          {cur.loaded && cur.loading && <div className="flex justify-center py-4"><Spinner /></div>}
        </div>
      </div>
    </div>
  )
}
