// Tema do painel: 'system' (segue o aparelho), 'light' ou 'dark'. A escolha fica no
// localStorage (cr.theme); index.html aplica a classe .dark ANTES de pintar (sem piscar) com a
// mesma regra de resolveTheme. Funcoes puras testadas em test/unit.mjs.
export const THEME_KEY = 'cr.theme'
export const THEMES = ['system', 'light', 'dark']
export const THEME_COLOR = { light: '#ffffff', dark: '#09090b' }

export const normTheme = (v) => (THEMES.includes(v) ? v : 'system')
export const resolveTheme = (pref, prefersDark) => {
  const p = normTheme(pref)
  return p === 'system' ? (prefersDark ? 'dark' : 'light') : p
}
export const nextTheme = (pref) => THEMES[(THEMES.indexOf(normTheme(pref)) + 1) % THEMES.length]

const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null)
export function readTheme() { try { return normTheme(localStorage.getItem(THEME_KEY)) } catch { return 'system' } }
export function applyTheme(pref) {
  const mode = resolveTheme(pref, !!mq()?.matches)
  const el = document.documentElement
  el.classList.toggle('dark', mode === 'dark')
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', THEME_COLOR[mode])
  return mode
}
export function saveTheme(pref) {
  const p = normTheme(pref)
  try { localStorage.setItem(THEME_KEY, p) } catch { /* modo privado */ }
  applyTheme(p)
  return p
}
// "sistema": acompanha a troca claro/escuro do aparelho sem recarregar
export function watchSystemTheme() {
  const m = mq()
  if (!m) return () => {}
  const on = () => { if (readTheme() === 'system') applyTheme('system') }
  m.addEventListener ? m.addEventListener('change', on) : m.addListener(on)
  return () => (m.removeEventListener ? m.removeEventListener('change', on) : m.removeListener(on))
}
