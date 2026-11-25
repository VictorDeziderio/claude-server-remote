// Tema antes de pintar (sem piscar). Mesma regra de src/lib/theme.js: system | light | dark.
// Arquivo separado (nao inline) por causa da CSP script-src 'self'.
(function () {
  try {
    var p = localStorage.getItem('cr.theme')
    var d = p === 'dark' || (p !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', d)
    var m = document.querySelector('meta[name="theme-color"]')
    if (m) m.setAttribute('content', d ? '#09090b' : '#ffffff')
  } catch (e) { /* fica no escuro (classe padrao do html) */ }
})()
