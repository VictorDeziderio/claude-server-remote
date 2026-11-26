// Conversations screen: project name, new-chat button, rows newest first, 20 at a time.
import React, { useRef } from 'react'
import { MessageSquarePlus, MessagesSquare } from 'lucide-react'
import { fmtWhen } from './format.js'
import { t } from '../lib/i18n.js'
import { Header, IconButton, Sentinel, Spinner, cx } from './ui.jsx'

const initial = (s) => (String(s || '').trim()[0] || '#').toUpperCase()

function Row({ c, onOpen }) {
  return (
    <li className="relative after:absolute after:bottom-0 after:left-[4.5rem] after:right-0 after:h-px after:bg-border/70 last:after:hidden">
      <button type="button" data-testid="conv-row" data-id={c.id} onClick={() => onOpen(c)}
        className="flex min-h-[4.5rem] w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent/60 active:bg-accent">
        <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-full bg-muted text-base font-semibold text-muted-foreground">{initial(c.title)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{c.title || t('chat.untitled')}</span>
            <span className={cx('shrink-0 text-xs tabular-nums', c.running ? 'text-brand' : 'text-muted-foreground')}>{fmtWhen(c.updatedAt)}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className={cx('min-w-0 flex-1 truncate text-sm', c.running ? 'text-brand' : 'text-muted-foreground')}>{c.running ? t('chat.typing') : c.preview || ' '}</span>
            {c.running && <span data-testid="running-dot" aria-label={t('chat.running')} className="size-2.5 shrink-0 animate-pulse rounded-full bg-brand" />}
          </span>
        </span>
      </button>
    </li>
  )
}

export function ConversationList({ me, items, next, loading, error, onMore, onRetry, onOpen, onNew }) {
  const scroller = useRef(null)
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="screen-list">
      <Header testid="list-header"
        right={<IconButton label={t('chat.newChat')} data-testid="new-chat" onClick={onNew}><MessageSquarePlus className="size-6" /></IconButton>}>
        <div className="px-2.5">
          <div className="truncate text-lg font-semibold leading-tight">{me?.project || t('chat.title')}</div>
          {me?.label && <div className="truncate text-xs leading-tight text-muted-foreground">{me.label}{me.role === 'owner' ? ` · ${t('chat.roleOwner')}` : ''}</div>}
        </div>
      </Header>
      <div ref={scroller} data-testid="list-scroll" className="chat-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {items.length > 0 && <ul data-testid="conv-list" className="pb-[env(safe-area-inset-bottom)]">{items.map((c) => <Row key={c.id} c={c} onOpen={onOpen} />)}</ul>}
        <Sentinel enabled={!!next && !loading && !error} onHit={onMore} rootRef={scroller} testid="list-sentinel" />
        {loading && <div className="flex justify-center py-6"><Spinner /></div>}
        {error && !loading && (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
            {t('chat.loadFailed')}
            <button type="button" onClick={onRetry} className="min-h-11 rounded-full border px-5 text-foreground hover:bg-accent">{t('chat.retry')}</button>
          </div>
        )}
        {!loading && !error && !items.length && (
          <div data-testid="list-empty" className="flex flex-col items-center gap-3 px-8 py-16 text-center">
            <span className="grid size-16 place-items-center rounded-full bg-muted text-muted-foreground"><MessagesSquare className="size-8" /></span>
            <div className="text-base font-medium">{t('chat.emptyList')}</div>
            <div className="text-sm text-muted-foreground">{t('chat.emptyListHint')}</div>
            <button type="button" onClick={onNew} className="mt-2 min-h-11 rounded-full bg-brand px-6 text-[15px] font-medium text-white hover:bg-brand/90">{t('chat.startChat')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
