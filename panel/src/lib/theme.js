// Panel theme: 'system' (follows the device), 'light' or 'dark'. The choice is kept in
// localStorage (cr.theme); index.html applies the .dark class BEFORE painting (no flash) with the
// same rule as resolveTheme. Pure functions tested in test/unit.mjs.
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
// "system": follows the device's light/dark switch without reloading
export function watchSystemTheme() {
  const m = mq()
  if (!m) return () => {}
  const on = () => { if (readTheme() === 'system') applyTheme('system') }
  m.addEventListener ? m.addEventListener('change', on) : m.addListener(on)
  return () => (m.removeEventListener ? m.removeEventListener('change', on) : m.removeListener(on))
}
