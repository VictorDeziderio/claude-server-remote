import { useEffect, useState, useRef, useCallback } from 'react'
import { Loader2, ChevronUp, ChevronDown, Send, ExternalLink, LogIn } from 'lucide-react'
import * as api from '../api.js'

// extrai URLs https da tela (ex.: link de login OAuth que o Claude imprime)
const findUrls = (txt) => [...new Set((txt.match(/https?:\/\/[^\s'"()\]]+/g) || []))].slice(0, 3)

// Console simples da sessao tmux do projeto: mostra a tela (polling) e envia teclas.
// Serve para LOGAR o Claude (rodar /login, escolher conta com ↑ ↓ Enter) pelo painel.
export default function Terminal({ projects = [], initialName = '', onFlash }) {
  const [sel, setSel] = useState(initialName || projects[0]?.name || '')
  const [screen, setScreen] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const preRef = useRef(null)

  const capture = useCallback(async (name) => {
    if (!name) return
    const r = await api.termCapture(name)
    setScreen(r.ok ? r.content : `[sessão indisponível: ${r.msg || ''}]`)
  }, [])

  useEffect(() => { if (!sel && projects[0]) setSel(projects[0].name) }, [projects, sel])

  useEffect(() => {
    capture(sel)
    const t = setInterval(() => capture(sel), 1500)
    return () => clearInterval(t)
  }, [sel, capture])

  useEffect(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight }, [screen])

  const send = async (text, key) => {
    if (!sel) return
    setBusy(true)
    const r = await api.termSend(sel, text || '', key || '')
    setBusy(false)
    if (r && r.ok === false) onFlash?.(r)
    setTimeout(() => capture(sel), 200)
  }
  const submit = async () => { await send(input, 'Enter'); setInput('') }

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
            {projects.length === 0 && <option value="">(nenhum projeto)</option>}
            {projects.map((p) => <option key={p.name} value={p.name}>claude-{p.name}</option>)}
          </select>
          <KeyBtn onClick={() => send('claude', 'Enter')}><LogIn className="h-3.5 w-3.5" /> claude</KeyBtn>
          <KeyBtn onClick={() => send('/login', 'Enter')}><LogIn className="h-3.5 w-3.5" /> /login</KeyBtn>
        </div>
        <div className="flex items-center gap-1">
          <KeyBtn onClick={() => send('', 'Up')}><ChevronUp className="h-3.5 w-3.5" /></KeyBtn>
          <KeyBtn onClick={() => send('', 'Down')}><ChevronDown className="h-3.5 w-3.5" /></KeyBtn>
          <KeyBtn onClick={() => send('', 'Enter')}>Enter</KeyBtn>
          <KeyBtn onClick={() => send('', 'Escape')}>Esc</KeyBtn>
          <KeyBtn onClick={() => send('', 'C-c')}>Ctrl+C</KeyBtn>
        </div>
      </div>

      {/* Login do Claude: link detectado na tela -> abrir -> colar o código no input abaixo */}
      {urls.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/5 bg-claude/5 px-4 py-2.5">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-claude"><ExternalLink className="h-3.5 w-3.5" /> link na tela:</span>
          {urls.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer"
              className="max-w-full truncate rounded-md bg-ink-900 px-2 py-1 text-xs text-sky-300 underline-offset-2 ring-1 ring-white/10 hover:underline">
              {u}
            </a>
          ))}
          <span className="text-[11px] text-slate-500">→ abra, autorize e cole o código no campo abaixo</span>
        </div>
      )}

      <pre
        ref={preRef}
        className="m-0 max-h-[55vh] min-h-[40vh] overflow-auto whitespace-pre-wrap bg-black/60 p-4 font-mono text-[12.5px] leading-relaxed text-slate-200"
      >
        {screen || '…'}
      </pre>

      <div className="flex items-center gap-2 border-t border-white/5 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          placeholder="digite e Enter — ex.: claude, /login, ls…"
          className="flex-1 rounded-lg bg-ink-900 px-3 py-2 font-mono text-sm text-slate-200 ring-1 ring-white/10 focus:outline-none focus:ring-claude/40"
        />
        <button
          onClick={submit}
          disabled={busy || !sel}
          className="inline-flex items-center gap-1.5 rounded-lg bg-claude/90 px-3 py-2 text-sm font-medium text-white transition hover:bg-claude disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar
        </button>
      </div>
      <p className="px-4 pb-3 text-xs text-slate-500">
        Console da sessão tmux (atualiza a cada 1,5s). Para logar o Claude: digite <code className="text-slate-400">/login</code> e siga as opções com ↑ ↓ Enter.
      </p>
    </div>
  )
}

function KeyBtn({ onClick, children }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md bg-ink-700/60 px-2 py-1 text-xs text-slate-300 ring-1 ring-white/5 transition hover:bg-ink-500 hover:text-white"
    >
      {children}
    </button>
  )
}
