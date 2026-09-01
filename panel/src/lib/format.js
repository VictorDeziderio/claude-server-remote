export const fmtInt = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
export const fmtTok = (n) => {
  n = n || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
export const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kB' : (n || 0) + ' B')
export const fmtDate = (ms) => {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export const joinPath = (a, b) => (a ? a.replace(/\/+$/, '') + '/' + b : b)
export const parentOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
