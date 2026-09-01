import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  UserRound, LogOut, LogIn, Check, ExternalLink, SquareTerminal, ShieldCheck, ShieldOff, Smartphone, Monitor, Trash2,
  Tag, ArrowUpCircle, CheckCircle2, AlertTriangle, RefreshCw, Loader2,
} from 'lucide-react'
import QRCode from 'qrcode'
import XTerm from '../components/XTerm.jsx'
import { Btn, Modal, Card, inputCls, Skeleton, InlineConfirm } from '../components/ui.jsx'
import { fmtAgo, fmtDate } from '../lib/format.js'
import * as api from '../api.js'

const findUrls = (txt) => [...new Set((txt.match(/https?:\/\/[^\s'"()\]]+/g) || []))].filter((u) => !/claude\.ai\/code\/session/.test(u)).slice(0, 2)

export default function Account({ data, onFlash, refresh }) {
  const login = data.login || { logged: false, account: '', org: '', method: '' }
  const [showLogin, setShowLogin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)

  const doLogout = async () => {
    setBusy(true)
    const r = await api.claudeLogout()
    setBusy(false); setConfirmLogout(false)
    onFlash?.(r)
    refresh?.()
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl bg-ink-800 p-5 ring-1 ring-white/5">
        <div className="flex items-start gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-claude/30"><UserRound className="h-7 w-7 text-claude" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${login.logged ? 'bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,.5)]' : 'bg-rose-500'}`} />
              <span className="truncate text-lg font-semibold text-white">{login.logged ? (login.account || 'Conta conectada') : 'Nenhuma conta conectada'}</span>
            </div>
            {login.org && <div className="mt-1 text-sm text-slate-400">organização: {login.org}</div>}
            <div className="mt-1 text-sm text-slate-500">método: {login.method || '—'} · {data.version || '?'}</div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {login.logged ? (
            confirmLogout
              ? <InlineConfirm text="Deslogar a conta do Claude neste servidor? Você precisará logar de novo." onYes={doLogout} onNo={() => setConfirmLogout(false)} busy={busy} />
              : <Btn variant="danger" onClick={() => setConfirmLogout(true)} className="px-4 py-2 text-sm"><LogOut className="h-4 w-4" /> Deslogar do Claude</Btn>
          ) : (
            <Btn variant="accent" onClick={() => setShowLogin(true)} className="px-4 py-2 text-sm"><LogIn className="h-4 w-4" /> Logar no Claude</Btn>
          )}
          <Link to="/terminal/shell" className="inline-flex items-center gap-2 rounded-lg bg-ink-500 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-ink-500/70"><SquareTerminal className="h-4 w-4" /> Abrir terminal</Link>
        </div>
        <p className="mt-3 text-xs text-slate-500">O login do Claude é por conta (OAuth): você abre um link, autoriza e cola o código gerado. As credenciais ficam em <code>~/.claude</code> (volume) e persistem entre deploys.</p>
      </section>

      <ClaudeVersionCard onFlash={onFlash} refresh={refresh} />
      <TwoFactorCard onFlash={onFlash} />
      <SessionsCard onFlash={onFlash} />

      {showLogin && <LoginModal onClose={() => { setShowLogin(false); refresh?.() }} onFlash={onFlash} />}
    </div>
  )
}

// Versao do Claude Code: atual x ultima no npm, alerta de desatualizado e botao de atualizar
function ClaudeVersionCard({ onFlash, refresh }) {
  const [h, setH] = useState(null)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState('')
  const load = useCallback(() => api.health().then((r) => { if (r.ok) setH(r) }).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  const update = async () => {
    setBusy(true); setOut('')
    const r = await api.claudeUpdate().catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false); setOut(r.output || ''); onFlash?.(r); load(); refresh?.()
  }
  const c = (h && h.claude) || {}
  return (
    <Card title="Claude Code" subtitle={h ? `node ${h.node}` : ''} actions={<Btn size="sm" variant="ghost" onClick={load} title="verificar de novo"><RefreshCw className="h-3.5 w-3.5" /></Btn>}>
      {!h ? <Skeleton className="h-16" /> : (
        <>
          {c.updateAvailable && (
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-100 ring-1 ring-amber-500/30" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <span><b>Claude Code desatualizado:</b> instalado <code>{c.currentNum}</code>, disponível <code>{c.latest}</code>. Atualize para receber correções e novos recursos.</span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-ink-700 ring-1 ring-white/5"><Tag className="h-5 w-5 text-claude" /></div>
              <div>
                <div className="text-sm text-slate-100">instalado: <code className="text-white">{c.current || '?'}</code></div>
                <div className="text-xs text-slate-500">última no npm: {c.latest ? <code>{c.latest}</code> : <span className="text-amber-300">não consegui consultar (sem acesso ao registry?)</span>}</div>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {c.updateAvailable
                ? <Btn variant="accent" busy={busy} onClick={update} title="sudo npm i -g @anthropic-ai/claude-code@latest"><ArrowUpCircle className="h-4 w-4" /> Atualizar para {c.latest}</Btn>
                : c.latest ? <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300"><CheckCircle2 className="h-4 w-4" /> atualizado</span>
                  : <Btn variant="ghost" busy={busy} onClick={update}><ArrowUpCircle className="h-4 w-4" /> Forçar atualização</Btn>}
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">A atualização roda <code>npm i -g</code> no container (1–2 min). Sessões abertas continuam na versão antiga até você <b>Reiniciar</b> o projeto no dashboard. A imagem pina a versão <code>CLAUDE_CODE_VERSION</code> no Dockerfile — num redeploy ela volta a essa versão.</p>
          {out && <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-ink-900 p-2 font-mono text-[11px] text-slate-400">{out}</pre>}
        </>
      )}
    </Card>
  )
}

// 2FA (TOTP): ativar com QR + codigo, desativar com codigo
function TwoFactorCard({ onFlash }) {
  const [st, setSt] = useState(null)
  const [setup, setSetup] = useState(null) // { secret, otpauth, qr }
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const load = useCallback(() => api.sessions().then((r) => { if (r.ok) setSt(r.twofa) }).catch(() => {}), [])
  useEffect(() => { load() }, [load])

  const start = async () => {
    setBusy(true)
    const r = await api.totpSetup().catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    if (!r.ok) return onFlash?.(r)
    const qr = await QRCode.toDataURL(r.otpauth, { margin: 1, width: 200, color: { dark: '#e7e9ee', light: '#0b0d12' } })
    setSetup({ ...r, qr }); setCode('')
  }
  const enable = async () => {
    setBusy(true)
    const r = await api.totpEnable(code).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false); onFlash?.(r)
    if (r.ok) { setSetup(null); setCode(''); load() }
  }
  const disable = async () => {
    setBusy(true)
    const r = await api.totpDisable(code).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false); onFlash?.(r)
    if (r.ok) { setDisabling(false); setCode(''); load() }
  }
  const codeInput = <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={7} placeholder="123 456" autoComplete="one-time-code" className={`w-32 font-mono tracking-widest ${inputCls}`} onKeyDown={(e) => { if (e.key === 'Enter') (setup ? enable() : disable()) }} />

  return (
    <Card title="Autenticação em dois fatores (2FA)" subtitle={st?.enabled ? `ativo desde ${fmtDate(st.enabledAt)}` : 'desativado'}>
      {!st ? <Skeleton className="h-16" /> : st.enabled ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-emerald-300"><ShieldCheck className="h-5 w-5" /> O login pede senha <b>e</b> o código do autenticador.</span>
          {disabling ? (
            <span className="ml-auto inline-flex items-center gap-2">{codeInput}<Btn variant="danger" busy={busy} disabled={code.replace(/\s/g, '').length !== 6} onClick={disable}><ShieldOff className="h-4 w-4" /> Confirmar desativação</Btn><Btn variant="ghost" onClick={() => { setDisabling(false); setCode('') }}>Cancelar</Btn></span>
          ) : <Btn variant="ghost" className="ml-auto" onClick={() => setDisabling(true)}><ShieldOff className="h-4 w-4" /> Desativar 2FA</Btn>}
        </div>
      ) : setup ? (
        <div className="flex flex-col gap-4 sm:flex-row">
          <img src={setup.qr} alt="QR code do 2FA" className="h-[200px] w-[200px] shrink-0 rounded-xl ring-1 ring-white/10" />
          <div className="min-w-0 flex-1 space-y-3 text-sm text-slate-300">
            <p>1. Abra o app autenticador (Google Authenticator, Authy, 1Password, Bitwarden…) e escaneie o QR — ou digite a chave:</p>
            <code className="block break-all rounded-lg bg-ink-900 px-3 py-2 font-mono text-xs text-slate-200">{setup.secret}</code>
            <p>2. Digite o código de 6 dígitos que o app mostra para confirmar:</p>
            <div className="flex flex-wrap items-center gap-2">{codeInput}<Btn variant="accent" busy={busy} disabled={code.replace(/\s/g, '').length !== 6} onClick={enable}><Check className="h-4 w-4" /> Ativar 2FA</Btn><Btn variant="ghost" onClick={() => { setSetup(null); setCode('') }}>Cancelar</Btn></div>
            <p className="text-xs text-amber-300/90">Guarde a chave num lugar seguro: sem o app e sem a chave você perde o acesso ao painel (aí só apagando <code>~/.claude/.panel-totp.json</code> pelo Console do EasyPanel).</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-slate-300"><ShieldOff className="h-5 w-5 text-amber-300" /> Este painel expõe um shell no servidor. Ative o 2FA para exigir um código do celular além da senha.</span>
          <Btn variant="accent" className="ml-auto" busy={busy} onClick={start}><ShieldCheck className="h-4 w-4" /> Ativar 2FA</Btn>
        </div>
      )}
    </Card>
  )
}

// Sessoes ativas do painel: lista, encerrar uma, encerrar todas as outras
function SessionsCard({ onFlash }) {
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState('')
  const [confirmAll, setConfirmAll] = useState(false)
  const load = useCallback(() => api.sessions().then((r) => { if (r.ok) setList(r.sessions) }).catch(() => {}), [])
  useEffect(() => { load() }, [load])
  const revoke = async (id) => { setBusy(id); const r = await api.revokeSession(id); setBusy(''); onFlash?.(r); load() }
  const revokeAll = async () => { setBusy('all'); const r = await api.revokeOtherSessions(); setBusy(''); setConfirmAll(false); onFlash?.(r); load() }
  const uaShort = (ua) => {
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '?'
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'navegador'
    return `${br} · ${os}`
  }
  return (
    <Card title="Sessões do painel" subtitle={list ? `${list.length} ativa(s)` : ''}
      actions={list && list.length > 1 && (confirmAll
        ? <InlineConfirm text="Encerrar todas as outras sessões?" onYes={revokeAll} onNo={() => setConfirmAll(false)} busy={busy === 'all'} />
        : <Btn size="sm" variant="ghost" onClick={() => setConfirmAll(true)}><LogOut className="h-3.5 w-3.5" /> sair de todos os outros dispositivos</Btn>)}>
      {!list ? <Skeleton className="h-16" /> : (
        <ul className="divide-y divide-white/5">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              {/iPhone|iPad|Android/.test(s.ua) ? <Smartphone className="h-4 w-4 text-slate-500" /> : <Monitor className="h-4 w-4 text-slate-500" />}
              <div className="min-w-0 flex-1">
                <div className="text-slate-200">{uaShort(s.ua)} {s.current && <span className="ml-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">esta sessão</span>}</div>
                <div className="text-xs text-slate-500">IP {s.ip || '?'} · último acesso {fmtAgo(s.last * 1000)} · login {fmtDate(s.iat * 1000)} · expira {fmtDate(s.exp * 1000)}</div>
              </div>
              {!s.current && <Btn size="sm" variant="danger" busy={busy === s.id} onClick={() => revoke(s.id)}><Trash2 className="h-3.5 w-3.5" /> encerrar</Btn>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// Login do Claude dentro de um terminal REAL (sessao shell): dispara `claude`, detecta o link
// OAuth na tela e permite colar o codigo. Tudo interativo — setas/Enter funcionam direto.
function LoginModal({ onClose, onFlash }) {
  const termRef = useRef(null)
  const [urls, setUrls] = useState([])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const scan = useCallback(async () => {
    try { const r = await api.termCapture('shell'); if (r.ok) setUrls(findUrls(r.content)) } catch { /* */ }
  }, [])
  useEffect(() => { scan(); const t = setInterval(scan, 1500); return () => clearInterval(t) }, [scan])

  const start = async () => {
    setBusy(true)
    termRef.current?.send('\x03')
    setTimeout(() => { termRef.current?.send('claude\r'); setBusy(false); termRef.current?.focus() }, 150)
  }
  const sendCode = () => {
    if (!code.trim()) return
    termRef.current?.send(code.trim() + '\r')
    setCode('')
    onFlash?.({ ok: true, msg: 'código enviado ao Claude — acompanhe no terminal' })
  }

  return (
    <Modal title="Logar no Claude" icon={LogIn} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Btn variant="accent" busy={busy} onClick={start}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <SquareTerminal className="h-4 w-4" />} Iniciar login (roda <code>claude</code>)</Btn>
        <span className="text-xs text-slate-500">use ↑ ↓ Enter direto no terminal</span>
      </div>
      {urls.length > 0 && (
        <div className="mb-3 rounded-lg bg-claude/5 p-2.5 ring-1 ring-claude/20">
          <div className="mb-1 inline-flex items-center gap-1.5 text-xs font-medium text-claude"><ExternalLink className="h-3.5 w-3.5" /> abra para autorizar:</div>
          {urls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="block truncate text-xs text-sky-300 hover:underline">{u}</a>)}
        </div>
      )}
      <div className="h-[45vh] overflow-hidden rounded-lg ring-1 ring-white/10">
        <XTerm ref={termRef} target="shell" fontSize={12} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendCode() }} placeholder="cole aqui o código gerado pelo Claude (ou cole direto no terminal)"
          className={`flex-1 font-mono ${inputCls} px-3 py-2`} />
        <Btn variant="accent" disabled={!code.trim()} onClick={sendCode}><Check className="h-4 w-4" /> Enviar código</Btn>
      </div>
      <p className="mt-2 text-xs text-slate-500">1) "Iniciar login" → 2) escolha o login com a conta (↑ ↓ Enter) → 3) abra o link e autorize → 4) cole o código. Depois feche — a página atualiza.</p>
    </Modal>
  )
}
