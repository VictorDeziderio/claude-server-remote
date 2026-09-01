export const fmtInt = (n) => String(Math.round(n ?? 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
export const fmtTok = (n) => {
  n = n || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
export const fmtUsd = (v) => {
  v = v || 0
  if (v >= 100) return 'US$ ' + v.toFixed(0)
  if (v >= 1) return 'US$ ' + v.toFixed(2)
  return 'US$ ' + v.toFixed(3)
}
export const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kB' : (n || 0) + ' B')
export const fmtDate = (ms) => {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export const fmtIso = (s) => (s ? fmtDate(new Date(s).getTime()) : '')
export const fmtUptime = (sec) => {
  sec = Math.max(0, Math.round(sec || 0))
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
export const fmtAgo = (ms) => {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s atrás`
  if (s < 3600) return `${Math.floor(s / 60)}min atrás`
  if (s < 86400) return `${Math.floor(s / 3600)}h atrás`
  return `${Math.floor(s / 86400)}d atrás`
}
export const joinPath = (a, b) => (a ? a.replace(/\/+$/, '') + '/' + b : b)
export const parentOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
export const shortModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
