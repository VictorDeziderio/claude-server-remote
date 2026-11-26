// Theme before painting (no flash), shared by the panel (index.html) and the chat (chat.html).
// Separate file (not inline) because of the CSP script-src 'self'.
// - panel: same rule as src/lib/theme.js (cr.theme = system | light | dark);
// - chat (<script data-system>): follows the device only.
// Also the iPhone status bar of the home-screen app: "black-translucent" draws a WHITE clock/battery
// over the page, invisible on the light theme, so it is used only on dark; light keeps "default"
// (dark text on a light bar). Must run AFTER that meta tag. At runtime src/lib/theme.js keeps them
// in sync (STATUS_BAR / THEME_COLOR there).
(function () {
  var me = document.currentScript
  var systemOnly = !!(me && me.hasAttribute('data-system'))
  var dark = !systemOnly // the panel's default (the html's "dark" class) when nothing can be read
  try {
    var p = systemOnly ? null : localStorage.getItem('cr.theme')
    dark = p === 'dark' || (p !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch (e) { /* keeps the default */ }
  document.documentElement.classList.toggle('dark', dark)
  // a theme-color with media= (chat.html) already follows the device by itself
  var m = document.querySelector('meta[name="theme-color"]:not([media])')
  if (m) m.setAttribute('content', dark ? '#0a0a0a' : '#ffffff')
  var bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
  if (bar) bar.setAttribute('content', dark ? 'black-translucent' : 'default')
})()
