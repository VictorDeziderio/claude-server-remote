// Viewer of the Files page: images, PDF, video and audio open in the page (no download), with
// previous / next among the viewable files of the same folder. Arrows (buttons, keyboard ← →,
// swipe on a phone), Esc closes, and the file can still be downloaded or opened in a new tab.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2 } from 'lucide-react'
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
  const box = useRef(null)
  const closeBtn = useRef(null)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { setFailed(false); setLoaded(false) }, [index])
  const go = (d) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n) }
  useEffect(() => {
    const before = document.activeElement
    closeBtn.current?.focus()
    return () => { if (before && before.focus && document.contains(before)) before.focus() }
  }, [])
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || ''
      if (e.key === 'Escape') onClose()
      // ← → on a player seek it (its own keys), elsewhere they step through the files
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !['VIDEO', 'AUDIO', 'INPUT'].includes(tag)) go(e.key === 'ArrowLeft' ? -1 : 1)
      else if (e.key === 'Tab' && box.current) {
        // Tab stays inside the viewer (the page behind is hidden)
        const f = [...box.current.querySelectorAll('button:not([disabled]), a[href], video, audio, iframe')]
        if (!f.length) return
        const i = f.indexOf(document.activeElement)
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus() }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus() }
      }
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }) // eslint-disable-line react-hooks/exhaustive-deps
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
  // previous / next: in the top bar, or on the sides of the picture (`sides`)
  const nav = (place, icon, sides) => [[-1, ChevronLeft, 'viewer.prev', 'left-2'], [1, ChevronRight, 'viewer.next', 'right-2']].map(([d, Icon, label, side]) => (
    <button key={d} type="button" onClick={() => go(d)} disabled={d < 0 ? index === 0 : index === items.length - 1}
      className={`${btn} ${place} ${sides ? side : ''}`} aria-label={t(label)} title={t(label)} data-testid={d < 0 ? 'viewer-prev' : 'viewer-next'}>
      <Icon className={icon} />
    </button>
  ))
  const btn = 'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white/90 hover:bg-white/15 disabled:opacity-30'
  // on <body>, above everything of the panel (its phone tab bar included)
  return createPortal(
    <div ref={box} role="dialog" aria-modal="true" aria-label={item.name} data-testid="file-viewer" className="fixed inset-0 z-[100] flex flex-col bg-black text-white" style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        <button ref={closeBtn} type="button" onClick={onClose} className={btn} aria-label={t('viewer.close')} title={t('viewer.close')} data-testid="viewer-close"><X className="size-5" /></button>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-medium" data-testid="viewer-name">{item.name}</div>
          <div className="text-xs text-white/60">{t('viewer.position', { i: index + 1, n: items.length })}{item.size ? ` · ${fmtSize(item.size)}` : ''}</div>
        </div>
        {/* a PDF uses the whole area (and scrolls by touch on a phone): its arrows go up here */}
        {kind === 'pdf' && nav('', 'size-6')}
        <a href={src} target="_blank" rel="noreferrer" className={btn} aria-label={t('viewer.newTab')} title={t('viewer.newTab')}><ExternalLink className="size-5" /></a>
        <a href={api.fsDownloadUrl(item.path)} className={btn} aria-label={t('files.download')} title={t('files.download')}><Download className="size-5" /></a>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {failed ? (
          <div className="flex flex-col items-center gap-4 px-6 text-center text-sm text-white/70">
            <span>{t('viewer.cannotShow')}</span>
            <span className="flex flex-wrap justify-center gap-2">
              <a href={api.fsDownloadUrl(item.path)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 font-medium text-black"><Download className="size-4" /> {t('files.download')}</a>
              <a href={src} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/30 px-5"><ExternalLink className="size-4" /> {t('viewer.newTab')}</a>
            </span>
          </div>
        ) : kind === 'image' ? (
          <img key={src} src={src} alt={item.name} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} data-testid="viewer-image" className="max-h-full max-w-full select-none object-contain" draggable={false} />
        ) : kind === 'pdf' ? (
          <iframe key={src} src={src} title={item.name} data-testid="viewer-pdf" className="h-full w-full max-w-5xl border-0 bg-white" />
        ) : kind === 'video' ? (
          <video key={src} src={src} controls playsInline onError={() => setFailed(true)} data-testid="viewer-video" className="max-h-full max-w-full" />
        ) : (
          <audio key={src} src={src} controls onError={() => setFailed(true)} data-testid="viewer-audio" className="w-full max-w-md" />
        )}
        {kind === 'image' && !loaded && !failed && <Loader2 aria-hidden className="pointer-events-none absolute size-8 animate-spin text-white/60" />}
        {kind !== 'pdf' && nav('absolute top-1/2 -translate-y-1/2 bg-black/40 size-12', 'size-7', true)}
      </div>
    </div>,
    document.body,
  )
}
