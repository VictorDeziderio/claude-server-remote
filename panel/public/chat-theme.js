// Chat page: light/dark from the system before painting (no flash). Separate file because of the
// CSP script-src 'self'.
(function () {
  try { document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches) } catch (e) { /* stays light */ }
})()
