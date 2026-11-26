// Conversation screen: newest 50 messages, older ones on scroll-up, live reply over SSE
// (delta / tool / message / done / error), stop button, "jump to bottom" and the composer.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, ChevronLeft, Wrench, CircleAlert } from 'lucide-react'
import { api, stream } from './api.js'
import { fmtDay, fmtTime, kindOf, mergeById, toMs } from './format.js'
import { Markdown } from './markdown.jsx'
import { FileRow, Thumb } from './media.jsx'
import { Composer } from './Composer.jsx'
import { t } from '../lib/i18n.js'
import { Header, IconButton, Sentinel, Spinner, cx, toast } from './ui.jsx'

const NEAR_BOTTOM = 80

function ToolChips({ tools, live }) {
  const [open, setOpen] = useState(false)
  if (!tools?.length) return null
  const names = [...new Set(tools.map((x) => x.name))]
  const failed = tools.some((x) => x.ok === false)
  return (
    <div className="mb-1">
      <button type="button" data-testid="tool-chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted">
        <Wrench className={cx('size-3.5 shrink-0', live && 'animate-pulse text-brand')} aria-hidden />
        <span className="truncate">{names.slice(0, 3).join(' · ')}{names.length > 3 ? ' …' : ''}</span>
        <span className="shrink-0 tabular-nums">({tools.length})</span>
        {failed && <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label={t('chat.toolFailed')} />}
        <ChevronDown className={cx('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs">
          {tools.map((x, i) => (
            <li key={i} className="flex min-w-0 gap-2">
              <span className={cx('shrink-0 font-medium', x.ok === false && 'text-destructive')}>{x.name}</span>
              <span className="min-w-0 truncate font-mono text-muted-foreground">{x.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Attachments({ list, onView, mine }) {
  if (!list?.length) return null
  const media = list.filter((a) => ['image', 'video'].includes(kindOf(a)))
  const files = list.filter((a) => !['image', 'video'].includes(kindOf(a)))
  return (
    <div className="mb-1 space-y-1">
      {media.length > 0 && (
        <div className={cx('grid gap-1', media.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
          {media.map((a, i) => <Thumb key={a.path || i} att={a} src={a.localPreview} onOpen={() => onView(a)} className={cx('rounded-xl', media.length > 1 ? 'aspect-square' : 'aspect-[4/3] w-60 max-w-full')} />)}
        </div>
      )}
      {files.map((a, i) => <FileRow key={a.path || i} att={a} className={mine ? 'bg-background/70' : 'bg-muted/50'} />)}
    </div>
  )
}

function Bubble({ m, onView, live }) {
  const mine = m.role === 'user'
  return (
    <div data-testid={live ? 'bubble-live' : 'bubble'} data-role={m.role} className={cx('flex w-full', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('min-w-0 max-w-[85%] rounded-2xl px-3 py-2 text-[15px] leading-relaxed shadow-xs',
        mine ? 'rounded-br-md bg-secondary text-secondary-foreground' : 'rounded-bl-md border bg-card text-card-foreground')}>
        <ToolChips tools={m.tools} live={live} />
        <Attachments list={m.attachments} onView={onView} mine={mine} />
        {m.text
          ? (mine ? <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.text}</div> : <Markdown text={m.text} />)
          : live && <span data-testid="typing" className="inline-flex gap-1 py-1.5" aria-label={t('chat.typing')}>{[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 160}ms` }} />)}</span>}
        {!live && m.ts ? <div className={cx('mt-0.5 text-right text-[11px]', 'text-muted-foreground')}>{fmtTime(m.ts)}</div> : null}
      </div>
    </div>
  )
}

const dayKey = (v) => { const ms = toMs(v); if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }

let localSeq = 0
export function Conversation({ id: initialId, item, onBack, onInfo, onCreated, onActivity, onView, onMeta }) {
  const [cid, setCid] = useState(initialId || null)
  const [msgs, setMsgs] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(!!initialId)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [ready, setReady] = useState(!initialId)
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState(null) // { text, tools } while a reply streams
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef(null)
  const content = useRef(null)
  const stick = useRef(true)
  const prepend = useRef(null)
  const sse = useRef(null)
  const cidRef = useRef(cid)
  cidRef.current = cid

  const toBottom = (smooth) => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }) }

  // newest page again (after a run ends or the app comes back to the foreground).
  // final: the run is over, so the saved conversation has the whole reply. The streamed messages
  // go: their ids are not the saved ones (the server folds the parts of one reply into one message),
  // so keeping them would show the reply twice.
  const refresh = useCallback(async (id, { final = false } = {}) => {
    try {
      const r = await api.messages(id)
      const page = r.items || []
      const ids = new Set(page.map((m) => m.id))
      const first = toMs(page[0]?.ts)
      // older pages stay; streamed messages the page does not have yet stay after it; local echoes go
      setMsgs((prev) => {
        const keep = prev.filter((m) => !m.local && !ids.has(m.id) && !(final && m.live))
        return [...keep.filter((m) => !m.live && (!first || toMs(m.ts) <= first)), ...page, ...keep.filter((m) => m.live)]
      })
      setNext((n) => n ?? r.next ?? null)
    } catch { /* keep what is shown */ }
  }, [])

  const finish = useCallback((id) => {
    sse.current?.close(); sse.current = null
    setRunning(false); setLive(null)
    onActivity?.()
    if (id) refresh(id, { final: true })
  }, [refresh, onActivity])

  const connect = useCallback((id, { expect } = {}) => {
    sse.current?.close()
    let ended = false, got = !!expect
    // a (re)connect replays the finished messages of the run and then ONE delta with all the text
    // so far: drop the partial text shown before, or it would appear twice
    setLive(expect ? { text: '', tools: [] } : null)
    if (expect) setRunning(true)
    const end = () => { if (!ended) { ended = true; if (got) finish(id) } }
    const s = stream(id, (ev, d) => {
      if (ended) return
      if (ev === 'delta') { got = true; setRunning(true); setLive((l) => ({ tools: [], ...(l || {}), text: (l?.text || '') + (d.text || '') })) }
      else if (ev === 'tool') { got = true; setRunning(true); setLive((l) => ({ text: '', ...(l || {}), tools: [...(l?.tools || []), d] })) }
      else if (ev === 'message' && d?.id) {
        got = true
        setMsgs((prev) => {
          const m = { ...d, live: true }
          if (m.role === 'user') { const i = prev.findIndex((x) => x.local); if (i >= 0) return [...prev.slice(0, i), m, ...prev.slice(i + 1)] }
          return mergeById(prev, [m])
        })
        if (d.role === 'assistant') setLive({ text: '', tools: [] })
      } else if (ev === 'done') { got = true; end() }
      else if (ev === 'error') { toast(d?.msg || t('chat.runFailed')); got = true; end() }
    })
    sse.current = s
    s.done.then(end, (e) => { if (e?.name !== 'AbortError') end() })
  }, [finish])

  // first page + live state (the server replays the partial reply on connect)
  useEffect(() => {
    if (!initialId) return
    let live = true
    api.messages(initialId).then((r) => {
      if (!live) return
      // the stream may have delivered messages before this page arrived: keep them after it
      setMsgs((prev) => mergeById(r.items || [], prev)); setNext(r.next || null)
    }).catch(() => toast(t('chat.loadFailed'))).finally(() => { if (live) setLoading(false) })
    if (item?.running !== false) connect(initialId, { expect: !!item?.running })
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => sse.current?.close(), [])

  // back from the background (iOS freezes the page): reconnect and catch up
  useEffect(() => {
    const on = () => {
      if (document.visibilityState !== 'visible' || !cidRef.current) return
      refresh(cidRef.current)
      connect(cidRef.current, { expect: false })
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [refresh, connect])

  // keep the scroll: older messages added on top must not move what is on screen
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (prepend.current != null) { el.scrollTop = el.scrollHeight - prepend.current; prepend.current = null; return }
    if (!loading && !ready) { toBottom(); setReady(true); return }
    if (stick.current) toBottom()
  }, [msgs, live, loading, ready])

  // images and code blocks change height after render: follow the bottom while "stuck" there
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (stick.current && prepend.current == null) toBottom() })
    ro.observe(content.current)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = scroller.current
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
    stick.current = near
    if (near !== atBottom) setAtBottom(near)
  }

  const loadOlder = async () => {
    if (!next || loadingOlder || !cid) return
    setLoadingOlder(true)
    try {
      const r = await api.messages(cid, next)
      const el = scroller.current
      prepend.current = el ? el.scrollHeight - el.scrollTop : null
      setMsgs((prev) => mergeById(prev, r.items || [], true))
      setNext(r.next || null)
    } catch { toast(t('chat.loadFailed')) } finally { setLoadingOlder(false) }
  }

  const send = async (text, atts) => {
    const local = { id: `local-${++localSeq}`, local: true, role: 'user', ts: Date.now(), text, tools: [], attachments: atts }
    stick.current = true
    setMsgs((prev) => [...prev, local])
    try {
      const r = await api.send(cid, text, atts.map((a) => a.path))
      const id = r.id || cid
      if (!cid && id) { setCid(id); onCreated?.(id) }
      connect(id, { expect: true })
      onActivity?.()
      return true
    } catch (e) {
      setMsgs((prev) => prev.filter((m) => m.id !== local.id))
      toast(e?.status === 409 ? t('chat.busy') : e?.status === 429 ? (e.message && !/^HTTP/.test(e.message) ? e.message : t('chat.tooMany')) : t('chat.sendFailed'))
      return false
    }
  }
  const stop = async () => {
    const id = cid
    try { await api.stop(id) } catch { toast(t('chat.stopFailed')); return }
    // the run ends with a `done` event; if the stream is gone, do not leave the button stuck
    setTimeout(() => { if (cidRef.current === id && sse.current) finish(id) }, 5000)
  }

  const firstUser = msgs.find((m) => m.role === 'user')?.text
  // for the info screen: the start date is known only once the oldest page is loaded
  const first = next ? null : msgs[0]?.ts
  useEffect(() => { onMeta?.({ first, firstUser }) }, [first, firstUser]) // eslint-disable-line react-hooks/exhaustive-deps
  const title = item?.title || (firstUser ? firstUser.slice(0, 60) : t('chat.newChat'))
  const sub = running ? t('chat.typing') : item?.updatedAt ? t('chat.updated', { when: fmtTime(item.updatedAt) }) : cid ? t('chat.tapInfo') : ''

  let lastDay = ''
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="screen-conversation">
      <Header testid="conv-header"
        left={<IconButton label={t('chat.back')} onClick={onBack} data-testid="back-btn"><ChevronLeft className="size-7" /></IconButton>}>
        <button type="button" data-testid="conv-title" disabled={!cid} onClick={() => cid && onInfo(cid)} className="flex min-h-11 w-full min-w-0 flex-col justify-center text-left">
          <span className="block truncate text-[15px] font-semibold leading-tight">{title}</span>
          {sub && <span className={cx('block truncate text-xs leading-tight', running ? 'text-brand' : 'text-muted-foreground')}>{sub}</span>}
        </button>
      </Header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} data-testid="messages" className="chat-scroll absolute inset-0 overflow-y-auto overflow-x-hidden">
          <div ref={content} className="flex min-h-full flex-col justify-end gap-1.5 px-3 py-3">
            <Sentinel enabled={ready && !!next && !loadingOlder} onHit={loadOlder} rootRef={scroller} margin="200px 0px 0px 0px" testid="older-sentinel" />
            {loadingOlder && <div className="flex justify-center py-2"><Spinner /></div>}
            {loading && <div className="flex flex-1 items-center justify-center"><Spinner /></div>}
            {!loading && !msgs.length && !live && (
              <div data-testid="conv-empty" className="m-auto max-w-xs py-10 text-center text-sm text-muted-foreground">{t('chat.emptyConversation')}</div>
            )}
            {msgs.map((m) => {
              const dk = dayKey(m.ts)
              const sep = dk && dk !== lastDay
              if (dk) lastDay = dk
              return (
                <React.Fragment key={m.id}>
                  {sep && <div className="sticky top-1 z-[1] mx-auto my-1 rounded-full border bg-background px-3 py-0.5 text-[11px] text-muted-foreground shadow-xs">{fmtDay(m.ts)}</div>}
                  <Bubble m={m} onView={onView} />
                </React.Fragment>
              )
            })}
            {live && <Bubble live m={{ id: 'live', role: 'assistant', text: live.text, tools: live.tools }} onView={onView} />}
          </div>
        </div>
        {!atBottom && (
          <button type="button" data-testid="jump-bottom" aria-label={t('chat.jumpBottom')} onClick={() => { stick.current = true; toBottom(true) }}
            className="absolute bottom-3 right-3 z-10 grid size-11 place-items-center rounded-full border bg-background text-foreground shadow-md">
            <ArrowDown className="size-5" />
          </button>
        )}
      </div>

      <Composer running={running} onSend={send} onStop={stop} autoFocus={!initialId} />
    </div>
  )
}
