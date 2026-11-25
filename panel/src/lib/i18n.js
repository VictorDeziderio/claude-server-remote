// Interface texts: the code uses KEYS (t('dashboard.title')) and the text comes from one file
// per language in src/locales/<code>.json. A new language = a new file (e.g. es.json) with
// "_name": "Español" — it shows up by itself in the language picker. en.json is the default and the fallback:
// a key missing in a language falls back to English; one missing in English shows the key itself.
// Variables: t('projects.count', { n: 3 }) with "{n} projects" in the file.
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
// changes the language and reloads (simple: no component needs to "listen" to the change)
export function setLang(code) {
  try { localStorage.setItem(LANG_KEY, code) } catch { /* modo privado */ }
  location.reload()
}
export const t = (key, vars) => lookup(LOCALES, lang, DEFAULT_LANG, key, vars)
// text coming from the server (e.g. a log name): uses the key if it exists, otherwise its own text
export const tOr = (key, fallback, vars) => (key in (LOCALES[lang] || {}) || key in (LOCALES[DEFAULT_LANG] || {}) ? t(key, vars) : fallback)
// the server answers in the same language (server/i18n.js reads this cookie on every request)
try { document.cookie = `cr_lang=${encodeURIComponent(lang)}; path=/; max-age=31536000; SameSite=Lax` } catch { /* no DOM (tests) */ }
