// Text of a server notice (SSE 'notify' or /api/alerts) in the language of WHOEVER IS LOOKING.
// The server sends the key + variables (i18n: {title: [key, vars], body: [key, vars]}, or
// key/vars in alerts) and the English text as the fallback; the translation happens here.
// Pure (no imports): gets tOr from i18n.js — so it also runs in the node tests.
const pick = (tOr, pair, fallback) => (Array.isArray(pair) && pair[0] ? tOr(pair[0], fallback, pair[1] || {}) : fallback)

export function noticeText(n = {}, tOr) {
  if (n.alertKind) { // alert (SSE or /api/alerts)
    const kind = n.alertKind
    const title = tOr('alert.kind.' + kind, kind) + (n.project ? ` — ${n.project}` : '')
    const raw = n.msg ?? n.body ?? ''
    const body = n.key ? tOr(n.key, raw, n.vars || {}) : raw
    return { title, body }
  }
  return { title: pick(tOr, n.i18n && n.i18n.title, n.title || ''), body: pick(tOr, n.i18n && n.i18n.body, n.body || '') }
}
export const noticeLine = (n, tOr) => { const { title, body } = noticeText(n, tOr); return body ? `${title} — ${body}` : title }
