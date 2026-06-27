import { useEffect, useState, useRef, useCallback } from 'react'
import { ExternalLink } from 'lucide-react'
import * as api from '../api.js'

// extrai URLs https da tela (ex.: link de login OAuth que o Claude imprime)
const findUrls = (txt) => [...new Set((txt.match(/https?:\/\/[^\s'"()\]]+/g) || []))].slice(0, 3)

// teclas especiais do teclado -> nomes do tmux send-keys
const KEYMAP = {
  Enter: 'Enter', Backspace: 'BSpace', Tab: 'Tab', Escape: 'Escape',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'DC',
}

// Terminal interativo: clica na tela e digita direto (como um SSH). Cada tecla vai pro tmux
// via send-keys; a saida e lida com capture-pane (polling). Sem campo de input.
export default function Terminal({ projects = [], initialName = '', onFlash }) {
  const [sel, setSel] = useState(initialName || 'shell') // 'shell' = bash em /root
  const [screen, setScreen] = useState('')
  const [focused, setFocused] = useState(false)
  const preRef = useRef(null)

  const capture = useCallback(async (name) => {
    const r = await api.termCapture(name)
    setScreen(r.ok ? r.content : `[sessão indisponível: ${r.msg || ''}]`)
  }, [])

  useEffect(() => {
    capture(sel)
    const t = setInterval(() => capture(sel), 800)
    return () => clearInterval(t)
  }, [sel, capture])

  useEffect(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight }, [screen])

  const send = useCallback(async (text, key) => {
    await api.termSend(sel, text || '', key || '')
    setTimeout(() => capture(sel), 120) // feedback rapido alem do polling
  }, [sel, capture])

  const onKeyDown = (e) => {
    if (e.metaKey) return // deixa Cmd+C/V/R do navegador passarem
    const k = e.key
    if (e.ctrlKey && k.length === 1 && /[a-z]/i.test(k)) { e.preventDefault(); return send('', 'C-' + k.toLowerCase()) }
    if (KEYMAP[k]) { e.preventDefault(); return send('', KEYMAP[k]) }
    if (k.length === 1 && !e.ctrlKey && !e.altKey) { e.preventDefault(); return send(k, '') }
  }
  const onPaste = (e) => {
    e.preventDefault()
    const txt = e.clipboardData?.getData('text') || ''
    if (txt) send(txt, '')
  }
  const urls = findUrls(screen)

  return (
    <div className="rounded-2xl bg-ink-800 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-400">sessão</span>
          <select
            value={sel}
            onChange={(e) => setSel(e.target.value)}
            className="rounded-lg bg-ink-900 px-2 py-1 text-sm text-slate-200 ring-1 ring-white/10 focus:outline-none focus:ring-claude/40"
          >
            <option value="shell">Shell (/root)</option>
            {projects.map((p) => <option key={p.name} value={p.name}>claude-{p.name}</option>)}
          </select>
          <span className={`inline-flex items-center gap-1.5 text-xs ${focused ? 'text-emerald-300' : 'text-slate-500'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${focused ? 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,.5)]' : 'bg-slate-600'}`} />
            {focused ? 'digitando' : 'clique na tela p/ digitar'}
          </span>
        </div>
      </div>

      {/* Login do Claude: link detectado na tela -> abrir, autorizar e o código é digitado direto */}
      {urls.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-claude/5 px-4 py-2.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-claude"><ExternalLink className="h-3.5 w-3.5" /> link na tela:</span>
          {urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer"
              className="max-w-full truncate rounded-md bg-ink-900 px-2 py-1 text-xs text-sky-300 underline-offset-2 ring-1 ring-white/10 hover:underline">{u}</a>
          ))}
        </div>
      )}

      <pre
        ref={preRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`m-0 max-h-[62vh] min-h-[46vh] cursor-text overflow-auto whitespace-pre-wrap bg-black/70 p-4 font-mono text-[12.5px] leading-relaxed text-slate-200 outline-none transition ${focused ? 'ring-2 ring-claude/40' : ''}`}
      >
        {screen || '…'}
      </pre>
      <p className="px-4 py-2 text-xs text-slate-500">
        Terminal real — clique na tela e digite direto (Enter, setas, Ctrl+C, colar funcionam). Para logar o Claude: digite <code className="text-slate-400">claude</code> ou <code className="text-slate-400">/login</code>.
      </p>
    </div>
  )
}
