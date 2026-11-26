// Public project chat (/remote/<project>?key=<key> or /c/<key>). It opens straight into THE
// conversation of the project (the one its terminal Claude is on). Phone: the info screen is
// routed by the URL hash (#/info) so a reload keeps the place; desktop (>= 1024px): the info is a
// right sidebar next to a centered conversation column.
import React, { useCallback, useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { UNAUTHORIZED, api, chatKey, linkProject, manifestHref, rememberKey } from './api.js'
import { Conversation } from './Conversation.jsx'
import { Info, NotifyBell } from './Info.jsx'
import { Viewer } from './media.jsx'
import { installWorker, usePush } from './push.js'
import { t } from '../lib/i18n.js'
import { Spinner, Toasts } from './ui.jsx'

export const parseRoute = (hash) => (String(hash || '').replace(/^#/, '') === '/info' ? 'info' : 'chat')
const WIDE = '(min-width: 1024px)'

function useWide() {
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(WIDE) : null
  const [wide, setWide] = useState(!!mq?.matches)
  useEffect(() => {
    if (!mq) return undefined
    const on = () => setWide(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return wide
}

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
  const [st, setSt] = useState(null)
  const [viewing, setViewing] = useState(null)
  const wide = useWide()
  const push = usePush(me?.project)

  const go = useCallback((r) => {
    const url = location.pathname + location.search + (r === 'info' ? '#/info' : '')
    history.pushState({ chat: 1 }, '', url)
    setRoute(r)
  }, [])
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash))
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  // back inside the app: use the browser history when we pushed the entry (keeps forward/back sane)
  const back = () => {
    if (history.state?.chat) history.back()
    else { history.replaceState(null, '', location.pathname + location.search); setRoute('chat') }
  }

  const loadMe = useCallback(() => {
    if (!chatKey()) return
    setStatus('loading')
    api.me().then((r) => { if (linkProject() && linkProject() !== r.project) return setStatus('invalid'); setMe(r); setStatus('ok') })
      .catch((e) => setStatus(e?.status === 401 || e?.status === 403 || e?.status === 404 ? 'invalid' : 'error'))
  }, [])
  useEffect(loadMe, [loadMe])
  // the key was revoked while the app was open
  useEffect(() => {
    const on = () => setStatus('invalid')
    window.addEventListener(UNAUTHORIZED, on)
    return () => window.removeEventListener(UNAUTHORIZED, on)
  }, [])

  // per-link app identity: home-screen name, tab title and the manifest of THIS link; the key is
  // remembered for this project and the service worker learns the link (notification taps)
  useEffect(() => {
    if (chatKey() && !document.querySelector('link[rel="manifest"]')) {
      const l = document.createElement('link')
      l.rel = 'manifest'
      l.href = manifestHref()
      document.head.appendChild(l)
    }
    if (!me?.project) return
    document.title = `Claude · ${me.project}`
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', me.project)
    rememberKey(me.project)
    if (import.meta.env.PROD) installWorker(me.project).catch(() => {})
  }, [me])

  const closeViewer = useCallback(() => setViewing(null), [])
  const openInfo = useCallback(() => go('info'), [go])

  if (status !== 'ok') return (
    <div className="chat-app h-full bg-background">
      {status === 'loading' ? <div className="flex h-full items-center justify-center"><Spinner /></div> : <Blocked kind={status} onRetry={loadMe} />}
    </div>
  )

  const phoneInfo = !wide && route === 'info'
  return (
    <div className="chat-app relative flex h-full overflow-hidden bg-background">
      <main className="flex h-full min-w-0 flex-1 flex-col" aria-hidden={phoneInfo || undefined}>
        <Conversation me={me} wide={wide} onState={setSt} onInfo={openInfo} onView={setViewing}
          bell={<NotifyBell push={push} onExplain={wide ? null : openInfo} />} />
      </main>
      {wide && (
        <aside data-testid="sidebar" className="h-full w-[360px] shrink-0 border-l bg-background xl:w-[380px]">
          <Info embedded me={me} st={st} push={push} onView={setViewing} />
        </aside>
      )}
      {phoneInfo && (
        <div className="absolute inset-0 z-20 bg-background">
          <Info me={me} st={st} push={push} onBack={back} onView={setViewing} />
        </div>
      )}
      <Viewer att={viewing} onClose={closeViewer} />
      <Toasts />
    </div>
  )
}
