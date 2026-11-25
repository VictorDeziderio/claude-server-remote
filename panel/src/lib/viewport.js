// REAL visible height on the phone (visualViewport): when the virtual keyboard opens, iOS does not
// shrink the page — it pushes it up and the terminal was hidden behind the keyboard.
// Here the visible height becomes the CSS variable --app-h (used by #root) and the iOS
// offset becomes --app-top; with the keyboard open <html> gets data-kb="1" (the CSS hides the
// bottom navigation and hints to leave room for the terminal).
import { keyboardOpen } from './termkeys.js'

export function installViewport() {
  if (typeof window === 'undefined' || installViewport.done) return
  installViewport.done = true
  const root = document.documentElement
  const vv = window.visualViewport
  // "full" height (no keyboard) per orientation: the biggest one seen so far
  let full = { portrait: 0, landscape: 0 }
  const update = () => {
    const h = vv ? vv.height : window.innerHeight
    const top = vv ? vv.offsetTop : 0
    // screen.orientation (not width > height): with the keyboard open the page looks "landscape"
    const o = (window.screen?.orientation?.type || '').startsWith('landscape') ? 'landscape' : 'portrait'
    full[o] = Math.max(full[o], window.innerHeight, h)
    root.style.setProperty('--app-h', `${Math.round(h)}px`)
    root.style.setProperty('--app-top', `${Math.round(top)}px`)
    if (keyboardOpen(h, full[o])) root.dataset.kb = '1'
    else delete root.dataset.kb
  }
  update()
  vv?.addEventListener('resize', update)
  vv?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', () => { full = { portrait: 0, landscape: 0 }; setTimeout(update, 250) })
}
