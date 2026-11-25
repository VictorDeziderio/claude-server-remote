// Theme before painting (no flash). Same rule as src/lib/theme.js: system | light | dark.
// Separate file (not inline) because of the CSP script-src 'self'.
(function () {
  try {
    var p = localStorage.getItem('cr.theme')
    var d = p === 'dark' || (p !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', d)
    var m = document.querySelector('meta[name="theme-color"]')
    if (m) m.setAttribute('content', d ? '#09090b' : '#ffffff')
  } catch (e) { /* stays dark (the html's default class) */ }
})()
