// Copy to the clipboard: Clipboard API (HTTPS/localhost) with a fallback to
// execCommand('copy') — which works on plain HTTP, as long as it is inside a user gesture.
export async function copyText(text) {
  if (!text) return false
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch { /* falls back */ }
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

// decodes the OSC 52 payload ("c;BASE64" / "p;BASE64" / ";BASE64") -> UTF-8 text | null
export function decodeOsc52(data) {
  const i = data.indexOf(';')
  if (i < 0) return null
  const b64 = data.slice(i + 1)
  if (!b64 || b64 === '?') return null // "?" = clipboard READ request: never served
  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch { return null }
}
