// Texto de um aviso do servidor (SSE 'notify' ou /api/alerts) no idioma de QUEM ESTA VENDO.
// O servidor manda a chave + variaveis (i18n: {title: [chave, vars], body: [chave, vars]}, ou
// key/vars nos alertas) e o texto em ingles como reserva; a traducao acontece aqui.
// Puro (sem imports): recebe o tOr do i18n.js — assim roda tambem nos testes do node.
const pick = (tOr, pair, fallback) => (Array.isArray(pair) && pair[0] ? tOr(pair[0], fallback, pair[1] || {}) : fallback)

export function noticeText(n = {}, tOr) {
  if (n.alertKind) { // alerta (SSE ou /api/alerts)
    const kind = n.alertKind
    const title = tOr('alert.kind.' + kind, kind) + (n.project ? ` — ${n.project}` : '')
    const raw = n.msg ?? n.body ?? ''
    const body = n.key ? tOr(n.key, raw, n.vars || {}) : raw
    return { title, body }
  }
  return { title: pick(tOr, n.i18n && n.i18n.title, n.title || ''), body: pick(tOr, n.i18n && n.i18n.body, n.body || '') }
}
export const noticeLine = (n, tOr) => { const { title, body } = noticeText(n, tOr); return body ? `${title} — ${body}` : title }
