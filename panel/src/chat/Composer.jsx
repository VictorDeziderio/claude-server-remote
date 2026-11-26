// Message composer: attach (camera / photos / files), auto-growing textarea, send or stop.
// Attachments upload right away (XHR, with progress); send waits until all of them are done.
import React, { useEffect, useRef, useState } from 'react'
import { ArrowUp, Camera, FileUp, Images, Paperclip, Square, X } from 'lucide-react'
import { upload } from './api.js'
import { fmtSize, kindOfFile } from './format.js'
import { FileGlyph } from './media.jsx'
import { t } from '../lib/i18n.js'
import { IconButton, cx, toast } from './ui.jsx'

const MAX_H = 168 // about 7 lines, then the textarea scrolls
const finePointer = () => typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches

let seq = 0
function AttachChip({ a, onRemove }) {
  return (
    <div data-testid="attach-chip" data-status={a.status} className="relative flex h-14 max-w-[13rem] shrink-0 items-center gap-2 overflow-hidden rounded-xl border bg-card pr-9 text-left">
      {a.preview
        ? <img src={a.preview} alt="" className="size-14 shrink-0 object-cover" />
        : <span className="ml-2 grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><FileGlyph att={{ name: a.name, kind: a.kind }} /></span>}
      <span className="min-w-0 py-1">
        <span className="block truncate text-xs font-medium">{a.name}</span>
        <span className={cx('block truncate text-[11px]', a.status === 'err' ? 'text-destructive' : 'text-muted-foreground')}>
          {a.status === 'err' ? t('chat.uploadFailed') : a.status === 'up' ? `${Math.round(a.progress * 100)}%` : fmtSize(a.size)}
        </span>
      </span>
      {a.status === 'up' && (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-muted" aria-hidden>
          <span data-testid="upload-progress" className="block h-full bg-brand transition-[width]" style={{ width: `${Math.round(a.progress * 100)}%` }} />
        </span>
      )}
      <button type="button" aria-label={t('chat.removeAttachment')} onClick={onRemove}
        className="absolute right-0 top-0 grid size-11 place-items-start justify-items-end p-1.5">
        <span className="grid size-5 place-items-center rounded-full bg-foreground/80 text-background"><X className="size-3" /></span>
      </button>
    </div>
  )
}

function AttachMenu({ onPick, onClose }) {
  useEffect(() => {
    const on = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])
  const items = [
    ['camera', Camera, t('chat.attachCamera')],
    ['photos', Images, t('chat.attachPhotos')],
    ['files', FileUp, t('chat.attachFiles')],
  ]
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div role="menu" data-testid="attach-menu" className="absolute bottom-full left-2 z-30 mb-2 w-56 overflow-hidden rounded-xl border bg-popover p-1 shadow-lg animate-fade-up">
        {items.map(([k, Icon, label]) => (
          <button key={k} type="button" role="menuitem" onClick={() => onPick(k)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] hover:bg-accent">
            <Icon className="size-5 text-muted-foreground" aria-hidden />{label}
          </button>
        ))}
      </div>
    </>
  )
}

export function Composer({ running, onSend, onStop, autoFocus }) {
  const [text, setText] = useState('')
  const [atts, setAtts] = useState([])
  const [menu, setMenu] = useState(false)
  const ta = useRef(null)
  const inputs = { camera: useRef(null), photos: useRef(null), files: useRef(null) }

  const grow = () => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_H) + 'px'
  }
  useEffect(grow, [text])
  useEffect(() => { if (autoFocus && finePointer()) ta.current?.focus() }, [autoFocus])
  // leaving the conversation: stop the uploads still running and free the image previews
  const attsRef = useRef(atts)
  attsRef.current = atts
  useEffect(() => () => {
    for (const a of attsRef.current) {
      if (a.status === 'up') a.abort?.()
      if (a.preview) URL.revokeObjectURL(a.preview)
    }
  }, [])

  const patch = (lid, p) => setAtts((l) => l.map((a) => (a.lid === lid ? { ...a, ...p } : a)))
  const addFiles = (files) => {
    for (const f of files) {
      const lid = ++seq
      const kind = kindOfFile(f)
      const up = upload(f, (p) => patch(lid, { progress: p }))
      const preview = kind === 'image' && typeof URL !== 'undefined' ? URL.createObjectURL(f) : ''
      setAtts((l) => [...l, { lid, name: f.name || 'file', size: f.size, kind, status: 'up', progress: 0, preview, abort: up.abort }])
      up.promise.then((att) => patch(lid, { status: 'ok', att, progress: 1 })).catch((e) => {
        if (e?.message !== 'aborted') patch(lid, { status: 'err' })
      })
    }
  }
  const remove = (a) => {
    if (a.status === 'up') a.abort?.()
    if (a.preview) URL.revokeObjectURL(a.preview)
    setAtts((l) => l.filter((x) => x.lid !== a.lid))
  }
  const pick = (k) => { setMenu(false); inputs[k].current?.click() }
  const onFiles = (e) => { addFiles([...(e.target.files || [])]); e.target.value = '' }

  const uploading = atts.some((a) => a.status === 'up')
  const ready = atts.filter((a) => a.status === 'ok')
  const canSend = !running && !uploading && (text.trim() || ready.length)

  const send = async () => {
    if (!canSend) { if (uploading) toast(t('chat.waitUploads')); return }
    const body = text.trim(), sent = ready
    setText('')
    setAtts((l) => l.filter((a) => a.status !== 'ok'))
    const ok = await onSend(body, sent.map((a) => a.att))
    if (!ok) { setText(body); setAtts((l) => [...sent, ...l]) }
    else sent.forEach((a) => { if (a.preview) setTimeout(() => URL.revokeObjectURL(a.preview), 60e3) })
  }
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && finePointer()) { e.preventDefault(); send() }
  }
  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])]
    if (files.length) { e.preventDefault(); addFiles(files) }
  }

  return (
    <div data-testid="composer" className="chat-bottom relative z-10 shrink-0 border-t bg-background">
      {atts.length > 0 && (
        <div data-testid="attach-chips" className="no-scrollbar flex gap-2 overflow-x-auto px-3 pt-2">
          {atts.map((a) => <AttachChip key={a.lid} a={a} onRemove={() => remove(a)} />)}
        </div>
      )}
      <div className="relative flex items-end gap-1 px-1.5 py-1.5">
        {menu && <AttachMenu onPick={pick} onClose={() => setMenu(false)} />}
        <IconButton label={t('chat.attach')} data-testid="attach-btn" aria-expanded={menu} onClick={() => setMenu((v) => !v)} variant="muted"><Paperclip className="size-5" /></IconButton>
        <input ref={inputs.camera} type="file" accept="image/*" capture="environment" hidden onChange={onFiles} data-testid="file-camera" />
        <input ref={inputs.photos} type="file" accept="image/*,video/*" multiple hidden onChange={onFiles} data-testid="file-photos" />
        <input ref={inputs.files} type="file" multiple hidden onChange={onFiles} data-testid="file-files" />
        <textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onPaste={onPaste}
          placeholder={t('chat.placeholder')} aria-label={t('chat.placeholder')} enterKeyHint="enter"
          className="my-0.5 max-h-[168px] min-h-10 min-w-0 flex-1 resize-none rounded-[1.25rem] border bg-muted/40 px-4 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus:border-ring" />
        {running
          ? <IconButton label={t('chat.stop')} data-testid="stop-btn" onClick={onStop} variant="solid"><Square className="size-4 fill-current" /></IconButton>
          : <IconButton label={t('chat.send')} data-testid="send-btn" disabled={!canSend} onClick={send} variant="brand"><ArrowUp className="size-5" /></IconButton>}
      </div>
    </div>
  )
}
