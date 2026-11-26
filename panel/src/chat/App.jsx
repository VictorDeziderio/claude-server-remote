// Public project chat (/c/<key>). Three screens routed by the URL hash so a reload keeps the place:
//   (none)          conversations
//   #/new           new conversation
//   #/c/<id>        conversation
//   #/c/<id>/info   conversation info (Media / Files / Links)
// The list stays mounted (hidden) under a conversation, so going back keeps its scroll and pages.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { UNAUTHORIZED, api, chatKey } from './api.js'
import { mergeById } from './format.js'
import { ConversationList } from './ConversationList.jsx'
import { Conversation } from './Conversation.jsx'
import { Info } from './Info.jsx'
import { Viewer } from './media.jsx'
import { t } from '../lib/i18n.js'
import { Spinner, Toasts, cx } from './ui.jsx'

export function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '')
  if (h === '/new') return { kind: 'conv', id: null }
  const m = /^\/c\/([^/]+)(\/info)?$/.exec(h)
  if (m) return { kind: m[2] ? 'info' : 'conv', id: decodeURIComponent(m[1]) }
  return { kind: 'list', id: null }
}
const hashOf = (r) => (r.kind === 'list' ? '' : r.id == null ? '#/new' : `#/c/${encodeURIComponent(r.id)}${r.kind === 'info' ? '/info' : ''}`)

function Blocked({ kind, onRetry }) {
  return (
    <div data-testid="blocked" className="chat-top chat-bottom flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-muted text-muted-foreground"><KeyRound className="size-8" /></span>
      <div className="text-base font-medium">{kind === 'invalid' ? t('chat.invalidLink') : t('chat.offline')}</div>
      <div className="text-sm text-muted-foreground">{kind === 'invalid' ? t('chat.invalidLinkHint') : t('chat.offlineHint')}</div>
      {kind !== 'invalid' && <button type="button" onClick={onRetry} className="mt-2 min-h-11 rounded-full border px-6 hover:bg-accent">{t('chat.retry')}</button>}
    </div>
  )
}

export default function App() {
  const [me, setMe] = useState(null)
  const [status, setStatus] = useState(chatKey() ? 'loading' : 'invalid')
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  const [list, setList] = useState({ items: [], next: null, loading: false, error: false })
  const [viewing, setViewing] = useState(null)
  const [meta, setMeta] = useState(null)
  // a new Conversation instance only when the conversation really changes (not when "new" gets its id)
  const active = useRef(route.kind === 'list' ? undefined : route.id)
  const [convKey, setConvKey] = useState(0)
  const listBusy = useRef(false)

  const applyRoute = useCallback((r) => {
    if (r.kind !== 'list' && r.id !== active.current) { active.current = r.id; setConvKey((k) => k + 1); setMeta(null) }
    if (r.kind === 'list') active.current = undefined
    setRoute(r)
  }, [])
  const go = useCallback((r, replace) => {
    const url = location.pathname + location.search + hashOf(r)
    if (replace) history.replaceState(history.state, '', url)
    else history.pushState({ chat: (history.state?.chat || 0) + 1 }, '', url)
    applyRoute(r)
  }, [applyRoute])
  useEffect(() => {
    const on = () => applyRoute(parseRoute(location.hash))
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [applyRoute])
  // back inside the app: use the browser history when we pushed the entry (keeps forward/back sane)
  const back = (to) => { if (history.state?.chat) history.back(); else go(to, true) }

  const loadMe = useCallback(() => {
    if (!chatKey()) return
    setStatus('loading')
    api.me().then((r) => { setMe(r); setStatus('ok') }).catch((e) => setStatus(e?.status === 401 || e?.status === 403 || e?.status === 404 ? 'invalid' : 'error'))
  }, [])
  useEffect(loadMe, [loadMe])
  // the key was revoked while the app was open
  useEffect(() => {
    const on = () => setStatus('invalid')
    window.addEventListener(UNAUTHORIZED, on)
    return () => window.removeEventListener(UNAUTHORIZED, on)
  }, [])

  // per-link app identity: home-screen name, tab title and the manifest of THIS link
  useEffect(() => {
    const key = chatKey()
    if (key && !document.querySelector('link[rel="manifest"]')) {
      const l = document.createElement('link')
      l.rel = 'manifest'
      l.href = `/c/${key}/manifest.webmanifest`
      document.head.appendChild(l)
    }
    if (me?.project) {
      document.title = `Claude · ${me.project}`
      document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', me.project)
    }
  }, [me])

  const loadList = useCallback(async (more) => {
    if (listBusy.current) return
    listBusy.current = true
    setList((l) => ({ ...l, loading: true, error: false }))
    try {
      const r = await api.conversations(more || undefined)
      setList((l) => ({
        items: more ? mergeById(l.items, r.items || []) : mergeById(r.items || [], l.items.filter((x) => !(r.items || []).some((y) => y.id === x.id))),
        next: more ? r.next || null : l.items.length > (r.items || []).length ? l.next : r.next || null,
        loading: false, error: false,
      }))
    } catch { setList((l) => ({ ...l, loading: false, error: true })) } finally { listBusy.current = false }
  }, [])
  useEffect(() => { if (status === 'ok') loadList() }, [status, loadList])
  // the list is live data: refresh when coming back to it or to the app
  useEffect(() => { if (status === 'ok' && route.kind === 'list') loadList() }, [route.kind]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible' && status === 'ok') loadList() }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [status, loadList])

  const onCreated = useCallback((id) => { active.current = id; go({ kind: 'conv', id }, true) }, [go])
  const closeViewer = useCallback(() => setViewing(null), [])

  if (status !== 'ok') return (
    <div className="chat-app mx-auto h-full max-w-[760px] bg-background md:border-x">
      {status === 'loading' ? <div className="flex h-full items-center justify-center"><Spinner /></div> : <Blocked kind={status} onRetry={loadMe} />}
    </div>
  )

  const item = route.id ? list.items.find((x) => x.id === route.id) : null
  const inConv = route.kind === 'conv' || route.kind === 'info'
  return (
    <div className="chat-app mx-auto h-full max-w-[760px] overflow-hidden bg-background md:border-x">
      <div className={cx('h-full', route.kind !== 'list' && 'hidden')}>
        <ConversationList me={me} items={list.items} next={list.next} loading={list.loading} error={list.error}
          onMore={() => loadList(list.next)} onRetry={() => loadList()}
          onOpen={(c) => go({ kind: 'conv', id: c.id })} onNew={() => go({ kind: 'conv', id: null })} />
      </div>
      {inConv && (
        <div className={cx('h-full', route.kind === 'info' && 'hidden')}>
          <Conversation key={convKey} id={route.id} item={item} onView={setViewing} onMeta={setMeta}
            onBack={() => back({ kind: 'list' })} onInfo={(id) => go({ kind: 'info', id })}
            onCreated={onCreated} onActivity={() => loadList()} />
        </div>
      )}
      {route.kind === 'info' && route.id && (
        <Info id={route.id} item={item} meta={meta} onView={setViewing} onBack={() => back({ kind: 'conv', id: route.id })} />
      )}
      <Viewer att={viewing} onClose={closeViewer} />
      <Toasts />
    </div>
  )
}
