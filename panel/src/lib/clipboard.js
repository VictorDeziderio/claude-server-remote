// Copiar para a area de transferencia: Clipboard API (HTTPS/localhost) com fallback para
// execCommand('copy') — que funciona em HTTP puro, desde que dentro de um gesto do usuario.
export async function copyText(text) {
  if (!text) return false
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch { /* cai no fallback */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
    const prev = document.activeElement
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    prev?.focus?.()
    return ok
  } catch { return false }
}

export async function readClipboard() {
  try { return (await navigator.clipboard.readText()) || '' } catch { return '' }
}

// decodifica o payload do OSC 52 ("c;BASE64" / "p;BASE64" / ";BASE64") -> texto UTF-8 | null
export function decodeOsc52(data) {
  const i = data.indexOf(';')
  if (i < 0) return null
  const b64 = data.slice(i + 1)
  if (!b64 || b64 === '?') return null // "?" = pedido de LEITURA do clipboard: nunca atendido
  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch { return null }
}
