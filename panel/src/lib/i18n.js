// Textos da interface: o codigo usa CHAVES (t('dashboard.title')) e o texto vem de um arquivo
// por idioma em src/locales/<codigo>.json. Idioma novo = um arquivo novo (ex.: es.json) com
// "_name": "Español" — aparece sozinho no seletor de idioma. en.json e' o padrao e a reserva:
// chave que falta num idioma cai no ingles; que falta no ingles mostra a propria chave.
// Variaveis: t('projects.count', { n: 3 }) com "{n} projects" no arquivo.
const files = import.meta.glob('../locales/*.json', { eager: true, import: 'default' })
export const LOCALES = Object.fromEntries(
  Object.entries(files).map(([p, dict]) => [p.split('/').pop().replace(/\.json$/, ''), dict]),
)
export const DEFAULT_LANG = 'en'
export const LANG_KEY = 'cr.lang'
export { pickLang, format, lookup } from './i18n-core.js'
import { pickLang, lookup } from './i18n-core.js'

const saved = () => { try { return localStorage.getItem(LANG_KEY) } catch { return null } }
const browser = () => (typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [])
let lang = pickLang(saved(), browser(), Object.keys(LOCALES), DEFAULT_LANG)
if (typeof document !== 'undefined') document.documentElement.lang = lang

export const getLang = () => lang
export const languages = () => Object.entries(LOCALES).map(([code, d]) => ({ code, name: d._name || code }))
// troca o idioma e recarrega (simples: nenhum componente precisa "ouvir" a troca)
export function setLang(code) {
  try { localStorage.setItem(LANG_KEY, code) } catch { /* modo privado */ }
  location.reload()
}
export const t = (key, vars) => lookup(LOCALES, lang, DEFAULT_LANG, key, vars)
// texto que vem do servidor (ex.: nome de um log): usa a chave se existir, senao o texto dele
export const tOr = (key, fallback, vars) => (key in (LOCALES[lang] || {}) || key in (LOCALES[DEFAULT_LANG] || {}) ? t(key, vars) : fallback)
// o servidor responde no mesmo idioma (server/i18n.js le este cookie em toda requisicao)
try { document.cookie = `cr_lang=${encodeURIComponent(lang)}; path=/; max-age=31536000; SameSite=Lax` } catch { /* sem DOM (testes) */ }
