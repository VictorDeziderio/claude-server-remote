// Small pure helpers for the chat screens (no DOM, no React).
import { t, getLang } from '../lib/i18n.js'

// Timestamps may come as epoch ms or ISO strings.
export const toMs = (v) => (v == null || v === '' ? 0 : typeof v === 'number' ? v : new Date(v).getTime() || 0)

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
export const fmtTime = (v) => {
  const ms = toMs(v)
  return ms ? new Date(ms).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' }) : ''
}
// List rows, WhatsApp style: time today, "Yesterday", weekday this week, otherwise the date.
export function fmtWhen(v, now = Date.now()) {
  const ms = toMs(v)
  if (!ms) return ''
  const d = new Date(ms), n = new Date(now)
  if (sameDay(d, n)) return fmtTime(ms)
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return t('chat.yesterday')
  if (now - ms < 6 * 86400e3) return d.toLocaleDateString(getLang(), { weekday: 'short' })
  return d.toLocaleDateString(getLang(), { day: '2-digit', month: '2-digit', year: '2-digit' })
}
export const fmtDay = (v) => {
  const ms = toMs(v)
  return ms ? new Date(ms).toLocaleDateString(getLang(), { day: 'numeric', month: 'long', year: 'numeric' }) : ''
}
export const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' kB' : (n || 0) + ' B')

export const baseName = (p) => String(p || '').split('/').pop()
const IMG = /\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|svg)$/i
const VID = /\.(mp4|mov|m4v|webm)$/i
const AUD = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i
export const kindOf = (att) => att?.kind || (IMG.test(att?.name || att?.path) ? 'image' : VID.test(att?.name || att?.path) ? 'video' : AUD.test(att?.name || att?.path) ? 'audio' : 'file')
export const kindOfFile = (file) => (/^image\//.test(file?.type) ? 'image' : /^video\//.test(file?.type) ? 'video' : /^audio\//.test(file?.type) ? 'audio' : kindOf({ name: file?.name }))

// A link item from /chat-api/media?tab=links may be a bare string or { url, title?, ts? }.
export const normLink = (it) => (typeof it === 'string' ? { url: it } : it || {})
export const hostOf = (url) => { try { return new URL(url).host } catch { return '' } }

// Put a page of items into a list: an item already there is REPLACED (a reply grows while Claude
// writes it), new ones go at the end, in their order.
export function upsertById(list, page) {
  const byId = new Map(page.filter(Boolean).map((x) => [x.id, x]))
  const out = list.map((x) => (byId.has(x.id) ? byId.get(x.id) : x))
  const have = new Set(list.map((x) => x.id))
  for (const x of page) if (x && !have.has(x.id)) out.push(x)
  return out
}
// whitespace-insensitive text, to match a sent message with the one saved in the conversation
export const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim()

// Merge a page of items into a list, keeping the first copy of each id.
export function mergeById(list, page, atStart = false) {
  const seen = new Set(list.map((x) => x.id))
  const fresh = page.filter((x) => x && !seen.has(x.id))
  return atStart ? [...fresh, ...list] : [...list, ...fresh]
}
