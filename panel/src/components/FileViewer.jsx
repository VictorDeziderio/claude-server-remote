// Viewer of the Files page: images, PDF, video and audio open in the page (no download), with
// previous / next among the viewable files of the same folder. Arrows (buttons, keyboard ← →,
// swipe on a phone), Esc closes, and the file can still be downloaded or opened in a new tab.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, Download, ExternalLink } from 'lucide-react'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'
import { fmtSize } from '../lib/format.js'

const EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
  pdf: ['pdf'],
  video: ['mp4', 'm4v', 'webm', 'mov'],
  audio: ['mp3', 'm4a', 'wav', 'ogg'],
}
export const viewKind = (name) => {
  const ext = (String(name).split('.').pop() || '').toLowerCase()
  return Object.keys(EXT).find((k) => EXT[k].includes(ext)) || ''
}

// items: [{ name, path, size }] (viewable files of the folder, in list order); index: the open one
export function FileViewer({ items, index, onIndex, onClose }) {
  const item = items[index]
  const touch = useRef(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [index])
  const go = (d) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n) }
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }) // eslint-disable-line react-hooks/exhaustive-deps
  // the neighbours of an image are loaded in the background: the next tap is instant
  useEffect(() => {
    for (const d of [-1, 1]) { const n = items[index + d]; if (n && viewKind(n.name) === 'image') { const im = new Image(); im.src = api.fsViewUrl(n.path) } }
  }, [index, items])
  if (!item) return null
  const kind = viewKind(item.name)
  const src = api.fsViewUrl(item.path)
  const onTouchStart = (e) => { const p = e.touches[0]; touch.current = { x: p.clientX, y: p.clientY } }
  const onTouchEnd = (e) => {
    const s = touch.current; touch.current = null
    if (!s || kind === 'pdf') return
    const p = e.changedTouches[0], dx = p.clientX - s.x, dy = p.clientY - s.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
  }
  const btn = 'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white/90 hover:bg-white/15 disabled:opacity-30'
  // on <body>, above everything of the panel (its phone tab bar included)
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={item.name} data-testid="file-viewer" className="fixed inset-0 z-[100] flex flex-col bg-black text-white" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        <button type="button" onClick={onClose} className={btn} aria-label={t('viewer.close')} title={t('viewer.close')} data-testid="viewer-close"><X className="size-5" /></button>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-medium" data-testid="viewer-name">{item.name}</div>
          <div className="text-xs text-white/60">{t('viewer.position', { i: index + 1, n: items.length })}{item.size ? ` · ${fmtSize(item.size)}` : ''}</div>
        </div>
        <a href={src} target="_blank" rel="noreferrer" className={btn} aria-label={t('viewer.newTab')} title={t('viewer.newTab')}><ExternalLink className="size-5" /></a>
        <a href={api.fsDownloadUrl(item.path)} className={btn} aria-label={t('files.download')} title={t('files.download')}><Download className="size-5" /></a>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {failed ? (
          <div className="px-6 text-center text-sm text-white/70">{t('viewer.cannotShow')}</div>
        ) : kind === 'image' ? (
          <img key={src} src={src} alt={item.name} onError={() => setFailed(true)} data-testid="viewer-image" className="max-h-full max-w-full select-none object-contain" draggable={false} />
        ) : kind === 'pdf' ? (
          <iframe key={src} src={src} title={item.name} data-testid="viewer-pdf" className="h-full w-full max-w-5xl border-0 bg-white" />
        ) : kind === 'video' ? (
          <video key={src} src={src} controls playsInline onError={() => setFailed(true)} data-testid="viewer-video" className="max-h-full max-w-full" />
        ) : (
          <audio key={src} src={src} controls onError={() => setFailed(true)} data-testid="viewer-audio" className="w-full max-w-md" />
        )}
        <button type="button" onClick={() => go(-1)} disabled={index === 0} className={`absolute left-2 top-1/2 -translate-y-1/2 bg-black/40 ${btn} size-12`} aria-label={t('viewer.prev')} title={t('viewer.prev')} data-testid="viewer-prev"><ChevronLeft className="size-7" /></button>
        <button type="button" onClick={() => go(1)} disabled={index === items.length - 1} className={`absolute right-2 top-1/2 -translate-y-1/2 bg-black/40 ${btn} size-12`} aria-label={t('viewer.next')} title={t('viewer.next')} data-testid="viewer-next"><ChevronRight className="size-7" /></button>
      </div>
    </div>,
    document.body,
  )
}
