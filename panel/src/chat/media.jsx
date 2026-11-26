// Images, videos and files of a conversation: lazy thumbnails, the full-screen viewer and downloads.
import React, { useEffect, useRef, useState } from 'react'
import { Download, File, FileText, FileArchive, FileCode, Image as ImageIcon, Music, Play, Video, X } from 'lucide-react'
import { fileUrl } from './api.js'
import { baseName, fmtSize, kindOf } from './format.js'
import { t } from '../lib/i18n.js'
import { IconButton, Spinner, cx } from './ui.jsx'

// URL of a project file, given only once the element is near the screen (lazy loading that also
// works inside scrolling lists). `failed` comes from the element's onError.
export function useFileUrl(path, ref, enabled = true) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!path || !enabled) return
    setFailed(false)
    let io
    if (ref?.current && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); setUrl(fileUrl(path)) } }, { rootMargin: '200px' })
      io.observe(ref.current)
    } else setUrl(fileUrl(path))
    return () => io?.disconnect()
  }, [path, ref, enabled])
  return { url, failed, onError: () => setFailed(true) }
}

export function downloadFile(att) {
  const a = document.createElement('a')
  a.href = fileUrl(att.path)
  a.download = att.name || baseName(att.path)
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const EXT_ICON = [
  [/\.(zip|tar|gz|tgz|rar|7z)$/i, FileArchive],
  [/\.(js|jsx|ts|tsx|py|sh|rb|go|rs|java|c|cpp|h|css|html|json|ya?ml|php|sql)$/i, FileCode],
  [/\.(txt|md|pdf|docx?|odt|rtf|csv|xlsx?)$/i, FileText],
]
export function FileGlyph({ att, className }) {
  const k = kindOf(att)
  const Icon = k === 'image' ? ImageIcon : k === 'video' ? Video : k === 'audio' ? Music : (EXT_ICON.find(([re]) => re.test(att?.name || att?.path || ''))?.[1] || File)
  return <Icon aria-hidden className={cx('size-5', className)} />
}

// Square/rounded image or video preview; `src` (local preview) wins over the remote path.
export function Thumb({ att, src, className, onOpen, testid = 'thumb' }) {
  const ref = useRef(null)
  const { url, failed, onError } = useFileUrl(src ? '' : att?.path, ref, !src)
  const shown = src || url
  const video = kindOf(att) === 'video'
  return (
    <button type="button" ref={ref} data-testid={testid} onClick={onOpen} aria-label={att?.name || baseName(att?.path)}
      className={cx('relative block overflow-hidden bg-muted', className)}>
      {shown && !failed && !video && <img src={shown} alt="" draggable={false} onError={onError} className="size-full object-cover" />}
      {shown && !failed && video && <video src={shown + '#t=0.1'} muted playsInline preload="metadata" onError={onError} className="size-full object-cover" />}
      {!shown && !failed && <span className="absolute inset-0 grid place-items-center"><Spinner className="size-4" /></span>}
      {failed && <span className="absolute inset-0 grid place-items-center text-muted-foreground"><ImageIcon className="size-5" /></span>}
      {video && <span className="absolute inset-0 grid place-items-center"><span className="grid size-9 place-items-center rounded-full bg-black/55 text-white"><Play className="size-4 fill-current" /></span></span>}
    </button>
  )
}

// Row for a non-image attachment (bubble and Files tab).
export function FileRow({ att, sub, className }) {
  return (
    <button type="button" data-testid="file-row" onClick={() => downloadFile(att)}
      className={cx('flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-accent/60', className)}>
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><FileGlyph att={att} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{att.name || baseName(att.path)}</span>
        <span className="block truncate text-xs text-muted-foreground">{[att.size ? fmtSize(att.size) : '', sub].filter(Boolean).join(' · ')}</span>
      </span>
      <Download aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

// Full-screen viewer for one image/video. Tap outside the picture or Escape closes it.
export function Viewer({ att, onClose }) {
  const { url, failed, onError } = useFileUrl(att?.path, null, !!att)
  useEffect(() => {
    if (!att) return
    const on = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [att, onClose])
  if (!att) return null
  const video = kindOf(att) === 'video'
  return (
    <div role="dialog" aria-modal="true" aria-label={t('chat.viewer')} data-testid="viewer" className="fixed inset-0 z-50 flex flex-col bg-black text-white animate-fade-in" onClick={onClose}>
      <div className="chat-top flex shrink-0 items-center gap-1 px-1.5" onClick={(e) => e.stopPropagation()}>
        <IconButton label={t('chat.close')} onClick={onClose} variant="dark"><X className="size-6" /></IconButton>
        <div className="min-w-0 flex-1 truncate text-sm">{att.name || baseName(att.path)}</div>
        <IconButton label={t('chat.download')} onClick={() => downloadFile(att)} variant="dark"><Download className="size-5" /></IconButton>
      </div>
      <div className="chat-bottom flex min-h-0 flex-1 items-center justify-center p-2">
        {!url && !failed && <Spinner className="text-white/70" />}
        {failed && <span className="text-sm text-white/70">{t('chat.loadFailed')}</span>}
        {url && !failed && !video && <img src={url} alt="" onError={onError} onClick={(e) => e.stopPropagation()} className="size-full object-contain" />}
        {url && !failed && video && <video src={url} onError={onError} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} className="max-h-full max-w-full" />}
      </div>
    </div>
  )
}
