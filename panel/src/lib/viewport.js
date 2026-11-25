// Altura REAL visivel no celular (visualViewport): quando o teclado virtual abre, o iOS nao
// encolhe a pagina — ele a empurra para cima e o terminal ficava escondido atras do teclado.
// Aqui a altura visivel vira a variavel CSS --app-h (usada pelo #root) e o deslocamento do
// iOS vira --app-top; com o teclado aberto o <html> ganha data-kb="1" (o CSS esconde a
// navegacao de baixo e dicas para sobrar espaco para o terminal).
import { keyboardOpen } from './termkeys.js'

export function installViewport() {
  if (typeof window === 'undefined' || installViewport.done) return
  installViewport.done = true
  const root = document.documentElement
  const vv = window.visualViewport
  // altura "cheia" (sem teclado) por orientacao: a maior ja vista
  let full = { portrait: 0, landscape: 0 }
  const update = () => {
    const h = vv ? vv.height : window.innerHeight
    const top = vv ? vv.offsetTop : 0
    // screen.orientation (e nao largura > altura): com o teclado aberto a pagina fica "deitada"
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
