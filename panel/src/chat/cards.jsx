// State cards above the composer: Claude not running (with "Start Claude"), and a question Claude
// asks in the terminal (its options as buttons; when the menu could not be read, the screen text
// with quick keys).
import React, { useEffect, useState } from 'react'
import { CircleHelp, Play, PowerOff } from 'lucide-react'
import { api } from './api.js'
import { t } from '../lib/i18n.js'
import { Spinner, cx, toast } from './ui.jsx'

const WHY = { disabled: 'chat.offDisabled', paused: 'chat.offPaused', down: 'chat.offDown', shell: 'chat.offShell' }

export function OffCard({ why }) {
  const [busy, setBusy] = useState(false)
  // the state event ends it (Claude comes up); give up the spinner after a while anyway
  useEffect(() => { if (!busy) return undefined; const id = setTimeout(() => setBusy(false), 45000); return () => clearTimeout(id) }, [busy])
  const go = async () => {
    setBusy(true)
    try { await api.start() } catch (e) { setBusy(false); toast(e?.message && !/^HTTP/.test(e.message) ? e.message : t('chat.startFailed')) }
  }
  return (
    <div data-testid="off-card" className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-3 shadow-xs">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><PowerOff className="size-5" aria-hidden /></span>
      <div className="min-w-0 flex-1 basis-48">
        <div className="text-[15px] font-medium">{t('chat.offTitle')}</div>
        <div className="text-sm text-muted-foreground">{t(WHY[why] || 'chat.offDown')}</div>
      </div>
      {/* phone: the button on a line of its own, full width; wider screens: on the right */}
      <button type="button" data-testid="start-btn" disabled={busy} onClick={go}
        className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-full bg-brand sm:w-auto px-4 text-[15px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-70">
        {busy ? <Spinner className="size-4 text-white" /> : <Play className="size-4 fill-current" aria-hidden />}
        {busy ? t('chat.starting') : t('chat.start')}
      </button>
    </div>
  )
}

const KEY_LABEL = { Enter: () => t('chat.keyEnter'), Escape: () => t('chat.keyEsc'), Up: () => '↑', Down: () => '↓', Tab: () => t('chat.keyTab') }
function QuickKeys({ list, onKey, busy }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="quick-keys">
      {list.map((k) => (
        <button key={k} type="button" data-testid="quick-key" data-key={k} disabled={busy} onClick={() => onKey(k)}
          className="min-h-11 min-w-11 rounded-xl border bg-background px-3 font-mono text-sm transition-colors hover:bg-accent disabled:opacity-50">
          {(KEY_LABEL[k] || (() => k))()}
        </button>
      ))}
    </div>
  )
}

export function QuestionCard({ q }) {
  const [busy, setBusy] = useState(false)
  // a new question (or the same one again later) gets fresh buttons
  useEffect(() => { setBusy(false) }, [q?.sig, q?.raw])
  const fail = (e) => { setBusy(false); toast(e?.status === 409 ? t('chat.questionChanged') : t('chat.answerFailed')) }
  // the screen normally moves on (new state); if it does not, the buttons come back after a while
  const pick = async (n) => { setBusy(true); try { await api.answer(n, q.sig); setTimeout(() => setBusy(false), 3000) } catch (e) { fail(e) } }
  const key = async (k) => { setBusy(true); try { await api.keys([k]) } catch (e) { fail(e) } finally { setTimeout(() => setBusy(false), 600) } }
  const parsed = q?.options?.length > 0
  const quick = parsed ? (q.multi ? ['Up', 'Down', 'Enter', 'Tab', 'Escape'] : ['Escape']) : [...(/\(y\/n\)|\[y\/n\]/i.test(q?.raw || '') ? ['y', 'n'] : []), '1', '2', '3', 'Up', 'Down', 'Enter', 'Escape']
  return (
    <div data-testid="question-card" data-parsed={parsed ? '1' : '0'} className="rounded-2xl border border-brand/40 bg-card p-3 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-brand">
        <CircleHelp className="size-4.5 shrink-0" aria-hidden />{parsed ? t('chat.askingTitle') : t('chat.askingRaw')}
      </div>
      {parsed && q.detail && <pre data-testid="question-detail" className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{q.detail}</pre>}
      {parsed && q.question && <div data-testid="question-text" className="mt-2 text-[15px] font-medium leading-snug">{q.question}</div>}
      {!parsed && <pre data-testid="question-screen" className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{q?.raw}</pre>}
      {parsed && (
        <div className="mt-2 flex flex-col gap-1.5">
          {q.options.map((o) => (
            <button key={o.n} type="button" data-testid="question-option" data-n={o.n} disabled={busy} onClick={() => pick(o.n)}
              className={cx('flex min-h-11 w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors hover:border-brand/60 hover:bg-accent disabled:opacity-50', o.n === q.cursor && 'border-brand/50')}>
              <span className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums">{o.n}</span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-[15px] leading-snug [overflow-wrap:anywhere]">{o.label}</span>
                {o.desc && <span className="block break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">{o.desc}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <QuickKeys list={quick} onKey={key} busy={busy} />
        {busy && <Spinner className="size-4" />}
      </div>
    </div>
  )
}

// Claude is working (seen on the terminal screen or from the hooks): dots in Claude's bubble spot
export function WorkingBubble() {
  return (
    <div data-testid="working" className="flex w-full justify-start">
      <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border bg-card px-3 py-2.5 text-sm text-muted-foreground shadow-xs">
        <span className="inline-flex gap-1" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="size-1.5 animate-pulse rounded-full bg-brand" style={{ animationDelay: `${i * 160}ms` }} />)}</span>
        {t('chat.working')}
      </div>
    </div>
  )
}
