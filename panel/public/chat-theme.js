// Chat page: light/dark from the system before painting (no flash). Separate file because of the
// CSP script-src 'self'. Also the iPhone status bar of the home-screen app: "black-translucent" draws
// WHITE clock/battery over the page, invisible on the light theme, so it is used only on dark;
// light keeps "default" (dark text on a light bar). Runs after that meta tag, before painting.
(function () {
  var dark = false
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches } catch (e) { /* stays light */ }
  document.documentElement.classList.toggle('dark', dark)
  var bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
  if (bar) bar.setAttribute('content', dark ? 'black-translucent' : 'default')
})()
