// THE conversation of the project: the one its terminal Claude is on (the server picks it).
// Newest 50 messages, older ones on scroll-up; live over SSE while Claude works in the terminal
// (`state`: conversation id, working / asking / idle / off; `messages`: new and grown messages).
// What is sent here is typed into that terminal. Above the composer: "Claude is not running"
// (Start) or Claude's question (its options as buttons).
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ChevronDown, CircleAlert, Clock, Info as InfoIcon, Wrench } from 'lucide-react'
import { ApiError, UNAUTHORIZED, api, stream } from './api.js'
import { fmtDay, fmtTime, kindOf, mergeById, normText, toMs, upsertById } from './format.js'
import { Markdown } from './markdown.jsx'
import { FileRow, Thumb } from './media.jsx'
import { Composer } from './Composer.jsx'
import { OffCard, QuestionCard, WorkingBubble } from './cards.jsx'
import { t } from '../lib/i18n.js'
import { Header, IconButton, Sentinel, Spinner, cx, toast } from './ui.jsx'

const NEAR_BOTTOM = 80

function ToolChips({ tools }) {
  const [open, setOpen] = useState(false)
  if (!tools?.length) return null
  const names = [...new Set(tools.map((x) => x.name))]
  const failed = tools.some((x) => x.ok === false)
  return (
    <div className="mb-1">
      <button type="button" data-testid="tool-chip" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted">
        <Wrench className="size-3.5 shrink-0" aria-hidden />
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

function Bubble({ m, onView }) {
  const mine = m.role === 'user'
  return (
    <div data-testid={m.local ? 'bubble-local' : 'bubble'} data-role={m.role} className={cx('flex w-full', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('min-w-0 max-w-[85%] rounded-2xl px-3 py-2 text-[15px] leading-relaxed shadow-xs lg:max-w-[80%] lg:text-base',
        mine ? 'rounded-br-md bg-secondary text-secondary-foreground' : 'rounded-bl-md border bg-card text-card-foreground')}>
        <ToolChips tools={m.tools} />
        <Attachments list={m.attachments} onView={onView} mine={mine} />
        {m.text && (mine ? <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.text}</div> : <Markdown text={m.text} />)}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
          {m.local ? <><Clock className="size-3" aria-hidden />{t('chat.sent')}</> : fmtTime(m.ts)}
        </div>
      </div>
    </div>
  )
}

// a message sent from here shows at once ("sent"); it goes away when the same text shows up in
// the conversation (Claude Code writes it when it takes the message; a busy Claude queues it)
function withEchoes(list, locals) {
  const users = list.filter((m) => m.role === 'user')
  const left = locals.filter((l) => {
    const txt = normText(l.text)
    return !users.some((u) => toMs(u.ts) >= l.ts - 10000 && (txt ? normText(u.text).includes(txt) : true))
  })
  return [...list, ...left]
}

const dayKey = (v) => { const ms = toMs(v); if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` }
const STATUS = { working: 'chat.working', asking: 'chat.asking', off: 'chat.offShort' }
const initial = (s) => (String(s || '').trim()[0] || '#').toUpperCase()

let localSeq = 0
export function Conversation({ me, onState, onInfo, onView, wide, bell }) {
  const [msgs, setMsgs] = useState([])
  const [next, setNext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [ready, setReady] = useState(false)
  const [st, setSt] = useState(null)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef(null)
  const content = useRef(null)
  const stick = useRef(true)
  const prepend = useRef(null)
  const conv = useRef(undefined) // conversation id of the messages on screen
  const sseRef = useRef(null)
  const retry = useRef(null)

  const toBottom = (smooth) => { const el = scroller.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }) }

  // newest page (first load, and when the terminal Claude moved to another conversation). A
  // reconnect does not reload: the stream starts with the newest messages, merged by id.
  const load = useCallback(async () => {
    try {
      const r = await api.messages()
      conv.current = r.conv || null
      setMsgs((prev) => withEchoes(r.items || [], prev.filter((m) => m.local)))
      setNext(r.next || null)
    } catch (e) { if (!(e instanceof ApiError && e.status === 401)) toast(t('chat.loadFailed')) } finally { setLoading(false) }
  }, [])

  const onEvent = useCallback((ev, d) => {
    if (ev === 'state' && d) {
      setSt(d)
      onState?.(d)
      // the terminal Claude moved to another conversation (/clear, a new session, --resume)
      if (conv.current !== undefined && d.conv !== conv.current) {
        conv.current = d.conv
        setMsgs((prev) => prev.filter((m) => m.local)); setNext(null); setReady(false); setLoading(true)
        load()
      }
    } else if (ev === 'messages' && d && d.conv === conv.current) {
      setMsgs((prev) => withEchoes(upsertById(prev.filter((m) => !m.local), d.items || []), prev.filter((m) => m.local)))
    }
  }, [load, onState])

  const connect = useCallback(() => {
    clearTimeout(retry.current)
    sseRef.current?.close()
    const s = stream(onEvent)
    sseRef.current = s
    const again = (e) => {
      if (sseRef.current !== s || e?.name === 'AbortError') return
      if (e?.status === 401) { try { window.dispatchEvent(new Event(UNAUTHORIZED)) } catch { /* */ } return }
      retry.current = setTimeout(connect, 3000)
    }
    s.done.then(() => again(), again)
  }, [onEvent])

  useEffect(() => {
    load().then(connect)
    return () => { clearTimeout(retry.current); sseRef.current?.close(); sseRef.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // back from the background (iOS freezes the page): reconnect (the stream catches up)
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible' && conv.current !== undefined) connect() }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [connect])

  const claude = st?.claude || ''
  // keep the scroll: older messages added on top must not move what is on screen
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (prepend.current != null) { el.scrollTop = el.scrollHeight - prepend.current; prepend.current = null; return }
    if (!loading && !ready) { toBottom(); setReady(true); return }
    if (stick.current) toBottom()
  }, [msgs, loading, ready, claude])

  // images and code blocks change height after render: follow the bottom while "stuck" there
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return undefined
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
    if (!next || loadingOlder) return
    setLoadingOlder(true)
    try {
      const r = await api.messages(next)
      if (r.conv !== conv.current) return
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
      await api.send(text, atts.map((a) => a.path))
      return true
    } catch (e) {
      setMsgs((prev) => prev.filter((m) => m.id !== local.id))
      toast(e?.message && !/^HTTP/.test(e.message) && e.status !== 401 ? e.message : t('chat.sendFailed'))
      return false
    }
  }
  const stop = async () => { try { await api.stop() } catch { toast(t('chat.stopFailed')) } }

  const mode = claude === 'off' ? 'off' : claude === 'asking' ? 'asking' : claude === 'working' ? 'working' : 'ready'
  const status = st ? (STATUS[claude] ? t(STATUS[claude]) : st.title || t('chat.idle')) : ''
  let lastDay = ''
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="screen-conversation">
      <Header testid="conv-header"
        left={<span aria-hidden className="ml-1.5 grid size-9 shrink-0 place-items-center rounded-full bg-brand/15 text-[15px] font-semibold text-brand">{initial(me?.project)}</span>}
        right={<>{bell}{!wide && <IconButton label={t('chat.info')} onClick={onInfo} data-testid="info-btn"><InfoIcon className="size-5" /></IconButton>}</>}>
        <button type="button" data-testid="conv-title" onClick={wide ? undefined : onInfo} tabIndex={wide ? -1 : 0}
          className={cx('flex min-h-11 w-full min-w-0 flex-col justify-center px-1.5 text-left', wide && 'cursor-default')}>
          <span className="block truncate text-[15px] font-semibold leading-tight lg:text-base">{me?.project || t('chat.title')}</span>
          <span data-testid="claude-status" data-state={claude} className={cx('block truncate text-xs leading-tight',
            claude === 'working' ? 'text-brand' : claude === 'asking' ? 'text-warning' : 'text-muted-foreground')}>{status}</span>
        </button>
      </Header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} data-testid="messages" className="chat-scroll absolute inset-0 overflow-y-auto overflow-x-hidden">
          <div ref={content} data-testid="messages-column" className="mx-auto flex min-h-full w-full max-w-[820px] flex-col justify-end gap-1.5 px-3 py-3 lg:gap-2 lg:px-6 lg:py-5">
            <Sentinel enabled={ready && !!next && !loadingOlder} onHit={loadOlder} rootRef={scroller} margin="200px 0px 0px 0px" testid="older-sentinel" />
            {loadingOlder && <div className="flex justify-center py-2"><Spinner /></div>}
            {loading && <div className="flex flex-1 items-center justify-center"><Spinner /></div>}
            {!loading && !msgs.length && (
              <div data-testid="conv-empty" className="m-auto max-w-xs py-10 text-center text-sm text-muted-foreground">{t('chat.emptyConversation')}</div>
            )}
            {msgs.map((m) => {
              const dk = m.local ? '' : dayKey(m.ts)
              const sep = dk && dk !== lastDay
              if (dk) lastDay = dk
              return (
                <React.Fragment key={m.id}>
                  {sep && <div className="sticky top-1 z-[1] mx-auto my-1 rounded-full border bg-background px-3 py-0.5 text-[11px] text-muted-foreground shadow-xs">{fmtDay(m.ts)}</div>}
                  <Bubble m={m} onView={onView} />
                </React.Fragment>
              )
            })}
            {claude === 'working' && <WorkingBubble />}
          </div>
        </div>
        {!atBottom && (
          <button type="button" data-testid="jump-bottom" aria-label={t('chat.jumpBottom')} onClick={() => { stick.current = true; toBottom(true) }}
            className="absolute bottom-3 right-3 z-10 grid size-11 place-items-center rounded-full border bg-background text-foreground shadow-md transition-colors hover:bg-accent lg:right-6">
            <ArrowDown className="size-5" />
          </button>
        )}
      </div>

      {(claude === 'off' || claude === 'asking') && (
        <div data-testid="state-cards" className="chat-scroll max-h-[55%] shrink-0 overflow-y-auto border-t bg-muted/30">
          <div className="mx-auto w-full max-w-[820px] px-3 py-2 lg:px-6">
            {claude === 'off' ? <OffCard why={st.why} /> : <QuestionCard q={st.question} />}
          </div>
        </div>
      )}
      <Composer mode={mode} onSend={send} onStop={stop} autoFocus />
    </div>
  )
}
