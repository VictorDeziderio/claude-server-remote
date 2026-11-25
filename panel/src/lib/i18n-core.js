// Regras puras do i18n (testadas em test/unit.mjs, sem Vite).
// Idioma: o salvo pelo usuario; senao o do navegador (pt-BR -> pt-BR, pt-PT -> pt-BR se so
// houver esse "pt"); senao o padrao.
export function pickLang(saved, browserLangs, available, def) {
  if (saved && available.includes(saved)) return saved
  for (const raw of browserLangs || []) {
    if (!raw) continue
    const l = String(raw)
    if (available.includes(l)) return l
    const base = l.split('-')[0].toLowerCase()
    const hit = available.find((a) => a.toLowerCase() === base || a.split('-')[0].toLowerCase() === base)
    if (hit) return hit
  }
  return def
}
export const format = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s)
export function lookup(locales, lang, def, key, vars) {
  const v = locales[lang]?.[key] ?? locales[def]?.[key] ?? key
  return format(v, vars)
}
