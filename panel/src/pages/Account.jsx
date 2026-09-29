import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { UserRound, LogOut, LogIn, Check, ExternalLink, SquareTerminal, ShieldCheck, ShieldOff, Smartphone, Monitor, Trash2, Tag, ArrowUpCircle, CheckCircle2, AlertTriangle, RefreshCw, Loader2, Copy, Link2 } from 'lucide-react'
import QRCode from 'qrcode'
import { copyText } from '../lib/clipboard.js'
import { Btn, Modal, Card, Dot, inputCls, Skeleton, InlineConfirm } from '../components/ui.jsx'
import { fmtAgo, fmtDate } from '../lib/format.js'
import * as api from '../api.js'

export default function Account({ data, onFlash, refresh }) {
  const login = data.login || { logged: false, account: '', org: '', method: '' }
  // /account?login=1 (link "deslogado — clique p/ logar" do Dashboard) ja abre o login
  const [params, setParams] = useSearchParams()
  const [showLogin, setShowLogin] = useState(() => params.get('login') === '1')
  useEffect(() => {
    if (params.get('login')) setParams({}, { replace: true })
  }, [params, setParams])
  const [busy, setBusy] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)

  const doLogout = async () => {
    setBusy(true)
    const r = await api.claudeLogout()
    setBusy(false)
    setConfirmLogout(false)
    onFlash?.(r)
    refresh?.()
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-start gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-accent ring-1 ring-primary/30">
            <UserRound className="h-7 w-7 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Dot on={login.logged} />
              <span className={`min-w-0 truncate text-sm text-slate-200 ${login.logged && login.account ? 'font-mono' : ''}`}>{login.logged ? login.account || 'Conta conectada' : 'Nenhuma conta conectada'}</span>
            </div>
            {login.org && <div className="mt-1.5 text-sm text-slate-400">organização: {login.org}</div>}
            <div className="mt-1.5 font-mono text-xs text-slate-500">
              método: {login.method || '—'} · {data.version || '?'}
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {login.logged ? (
            confirmLogout ? (
              <InlineConfirm text="Deslogar a conta do Claude neste servidor? Você precisará logar de novo." onYes={doLogout} onNo={() => setConfirmLogout(false)} busy={busy} />
            ) : (
              <>
                <Btn variant="danger" onClick={() => setConfirmLogout(true)} className="px-4 py-2 text-sm">
                  <LogOut className="h-4 w-4" /> Deslogar do Claude
                </Btn>
                <Btn onClick={() => setShowLogin(true)} className="px-4 py-2 text-sm">
                  <LogIn className="h-4 w-4" /> Trocar de conta
                </Btn>
              </>
            )
          ) : (
            <Btn variant="accent" onClick={() => setShowLogin(true)} className="px-4 py-2 text-sm">
              <LogIn className="h-4 w-4" /> Logar no Claude
            </Btn>
          )}
          <Link to="/terminal/shell" className="inline-flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-accent">
            <SquareTerminal className="h-4 w-4" /> Abrir terminal
          </Link>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          O login é por conta (OAuth): o painel já escolhe “Claude account with subscription”, você abre o link, autoriza, cola o código e clica em Conectar. As credenciais ficam em <code>~/.claude</code> (volume) e persistem entre deploys.
        </p>
      </Card>

      <ClaudeVersionCard onFlash={onFlash} refresh={refresh} />
      <TwoFactorCard onFlash={onFlash} />
      <SessionsCard onFlash={onFlash} />

      {showLogin && (
        <LoginModal
          onClose={() => {
            setShowLogin(false)
            refresh?.()
          }}
          onFlash={onFlash}
        />
      )}
    </div>
  )
}

// Versao do Claude Code: atual x ultima no npm, alerta de desatualizado e botao de atualizar
function ClaudeVersionCard({ onFlash, refresh }) {
  const [h, setH] = useState(null)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState('')
  const load = useCallback(
    () =>
      api
        .health()
        .then((r) => {
          if (r.ok) setH(r)
        })
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    load()
  }, [load])
  const update = async () => {
    setBusy(true)
    setOut('')
    const r = await api.claudeUpdate().catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    setOut(r.output || '')
    onFlash?.(r)
    load()
    refresh?.()
  }
  const c = (h && h.claude) || {}
  return (
    <Card
      title="Claude Code"
      subtitle={h ? `node ${h.node}` : ''}
      actions={
        <Btn size="sm" variant="ghost" onClick={load} title="verificar de novo">
          <RefreshCw className="h-3.5 w-3.5" />
        </Btn>
      }
    >
      {!h ? (
        <Skeleton className="h-16" />
      ) : (
        <>
          {c.updateAvailable && (
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-100 ring-1 ring-amber-500/30" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <span>
                <b>Claude Code desatualizado:</b> instalado <code>{c.currentNum}</code>, disponível <code>{c.latest}</code>. Atualize para receber correções e novos recursos.
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent border">
                <Tag className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="text-sm text-slate-100">
                  instalado: <code className="font-mono text-xs text-white">{c.current || '?'}</code>
                </div>
                <div className="font-mono text-xs text-slate-500">última no npm: {c.latest ? <code>{c.latest}</code> : <span className="font-sans text-amber-300">não consegui consultar (sem acesso ao registry?)</span>}</div>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {c.updateAvailable ? (
                <Btn variant="accent" busy={busy} onClick={update} title="sudo npm i -g @anthropic-ai/claude-code@latest">
                  <ArrowUpCircle className="h-4 w-4" /> Atualizar para {c.latest}
                </Btn>
              ) : c.latest ? (
                <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" /> atualizado
                </span>
              ) : (
                <Btn variant="ghost" busy={busy} onClick={update}>
                  <ArrowUpCircle className="h-4 w-4" /> Forçar atualização
                </Btn>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            A atualização roda <code>npm i -g</code> no container (1–2 min). Sessões abertas continuam na versão antiga até você <b>Reiniciar</b> o projeto no dashboard. A imagem pina a versão <code>CLAUDE_CODE_VERSION</code> no Dockerfile — num redeploy ela volta a essa versão.
          </p>
          {out && <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-background p-2 font-mono text-[11px] text-slate-400">{out}</pre>}
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
  const load = useCallback(
    () =>
      api
        .sessions()
        .then((r) => {
          if (r.ok) setSt(r.twofa)
        })
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  const start = async () => {
    setBusy(true)
    const r = await api.totpSetup().catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    if (!r.ok) return onFlash?.(r)
    const qr = await QRCode.toDataURL(r.otpauth, { margin: 1, width: 200, color: { dark: '#e7e9ee', light: '#0b0d12' } })
    setSetup({ ...r, qr })
    setCode('')
  }
  const enable = async () => {
    setBusy(true)
    const r = await api.totpEnable(code).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    onFlash?.(r)
    if (r.ok) {
      setSetup(null)
      setCode('')
      load()
    }
  }
  const disable = async () => {
    setBusy(true)
    const r = await api.totpDisable(code).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    onFlash?.(r)
    if (r.ok) {
      setDisabling(false)
      setCode('')
      load()
    }
  }
  const codeInput = (
    <input
      value={code}
      onChange={(e) => setCode(e.target.value)}
      inputMode="numeric"
      maxLength={7}
      placeholder="123 456"
      autoComplete="one-time-code"
      className={`w-32 font-mono tracking-widest ${inputCls}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setup ? enable() : disable()
      }}
    />
  )

  return (
    <Card title="Autenticação em dois fatores (2FA)" subtitle={st?.enabled ? `ativo desde ${fmtDate(st.enabledAt)}` : 'desativado'}>
      {!st ? (
        <Skeleton className="h-16" />
      ) : st.enabled ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-emerald-300">
            <ShieldCheck className="h-5 w-5" /> O login pede senha <b>e</b> o código do autenticador.
          </span>
          {disabling ? (
            <span className="ml-auto inline-flex items-center gap-2">
              {codeInput}
              <Btn variant="danger" busy={busy} disabled={code.replace(/\s/g, '').length !== 6} onClick={disable}>
                <ShieldOff className="h-4 w-4" /> Confirmar desativação
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => {
                  setDisabling(false)
                  setCode('')
                }}
              >
                Cancelar
              </Btn>
            </span>
          ) : (
            <Btn variant="ghost" className="ml-auto" onClick={() => setDisabling(true)}>
              <ShieldOff className="h-4 w-4" /> Desativar 2FA
            </Btn>
          )}
        </div>
      ) : setup ? (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="shrink-0 rounded-xl bg-white p-3 border">
            <img src={setup.qr} alt="QR code do 2FA" className="h-[200px] w-[200px] rounded-lg" />
          </div>
          <div className="min-w-0 flex-1 space-y-3 text-sm text-slate-300">
            <p>1. Abra o app autenticador (Google Authenticator, Authy, 1Password, Bitwarden…) e escaneie o QR — ou digite a chave:</p>
            <code className="block break-all rounded-lg bg-background px-3 py-2 font-mono text-xs text-slate-200">{setup.secret}</code>
            <p>2. Digite o código de 6 dígitos que o app mostra para confirmar:</p>
            <div className="flex flex-wrap items-center gap-2">
              {codeInput}
              <Btn variant="accent" busy={busy} disabled={code.replace(/\s/g, '').length !== 6} onClick={enable}>
                <Check className="h-4 w-4" /> Ativar 2FA
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => {
                  setSetup(null)
                  setCode('')
                }}
              >
                Cancelar
              </Btn>
            </div>
            <p className="text-xs text-amber-300/90">
              Guarde a chave num lugar seguro: sem o app e sem a chave você perde o acesso ao painel (aí só apagando <code>~/.claude/.panel-totp.json</code> pelo Console do EasyPanel).
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-slate-500">
            <Dot on={false} /> Este painel expõe um shell no servidor. Ative o 2FA para exigir um código do celular além da senha.
          </span>
          <Btn variant="accent" className="ml-auto" busy={busy} onClick={start}>
            <ShieldCheck className="h-4 w-4" /> Ativar 2FA
          </Btn>
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
  const load = useCallback(
    () =>
      api
        .sessions()
        .then((r) => {
          if (r.ok) setList(r.sessions)
        })
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    load()
  }, [load])
  const revoke = async (id) => {
    setBusy(id)
    const r = await api.revokeSession(id)
    setBusy('')
    onFlash?.(r)
    load()
  }
  const revokeAll = async () => {
    setBusy('all')
    const r = await api.revokeOtherSessions()
    setBusy('')
    setConfirmAll(false)
    onFlash?.(r)
    load()
  }
  const uaShort = (ua) => {
    const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '?'
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'navegador'
    return `${br} · ${os}`
  }
  return (
    <Card
      title="Sessões do painel"
      subtitle={list ? `${list.length} ativa(s)` : ''}
      actions={
        list &&
        list.length > 1 &&
        (confirmAll ? (
          <InlineConfirm text="Encerrar todas as outras sessões?" onYes={revokeAll} onNo={() => setConfirmAll(false)} busy={busy === 'all'} />
        ) : (
          <Btn size="sm" variant="ghost" onClick={() => setConfirmAll(true)}>
            <LogOut className="h-3.5 w-3.5" /> sair de todos os outros dispositivos
          </Btn>
        ))
      }
    >
      {!list ? (
        <Skeleton className="h-16" />
      ) : (
        <ul className="space-y-1.5">
          {list.map((s) => (
            <li key={s.id} className={`flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${s.current ? 'bg-primary/5 ring-1 ring-primary/25' : 'ring-1 ring-transparent'}`}>
              {/iPhone|iPad|Android/.test(s.ua) ? <Smartphone className="h-4 w-4 text-slate-500" /> : <Monitor className="h-4 w-4 text-slate-500" />}
              <div className="min-w-0 flex-1">
                <div className="text-slate-200">
                  {uaShort(s.ua)} {s.current && <span className="ml-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary-300">esta sessão</span>}
                </div>
                <div className="font-mono text-xs text-slate-500">
                  IP {s.ip || '?'} · último acesso {fmtAgo(s.last * 1000)} · login {fmtDate(s.iat * 1000)} · expira {fmtDate(s.exp * 1000)}
                </div>
              </div>
              {!s.current && (
                <Btn size="sm" variant="danger" busy={busy === s.id} onClick={() => revoke(s.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> encerrar
                </Btn>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// Login do Claude GUIADO: o servidor roda o `claude` numa sessao tmux larga (cr-login), avanca
// sozinho as telas (tema, "Claude account with subscription") e devolve o link OAuth INTEIRO.
// Aqui: abrir/copiar o link, colar o codigo e Conectar. Telas inesperadas aparecem com teclas.
const STEP_TEXT = {
  idle: 'iniciando…',
  starting: 'abrindo o Claude Code…',
  method: 'selecionando “Claude account with subscription”…',
  url: 'autorize no link abaixo e cole o código',
  'code-sent': 'validando o código…',
  success: 'conta conectada!',
  error: 'não deu certo',
  attention: 'o Claude está pedindo uma decisão sua',
}
function LoginModal({ onClose, onFlash }) {
  const [st, setSt] = useState({ phase: 'idle', url: '', msg: '', screen: '' })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [showScreen, setShowScreen] = useState(false)
  const doneRef = useRef(false)

  const begin = useCallback(async () => {
    setBusy(true)
    setCode('')
    const r = await api.loginStart().catch((e) => ({ ok: false, phase: 'error', msg: e.message }))
    setBusy(false)
    setSt(r)
  }, [])
  useEffect(() => {
    begin()
  }, [begin])
  useEffect(() => {
    const t = setInterval(() => {
      api
        .loginStatus()
        .then((r) => {
          if (r?.ok) setSt(r)
        })
        .catch(() => {})
    }, 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (st.phase === 'success' && !doneRef.current) {
      doneRef.current = true
      onFlash?.({ ok: true, msg: 'Claude conectado — projetos parados na tela de login foram reiniciados' })
    }
    if (st.phase === 'attention') setShowScreen(true)
  }, [st.phase, onFlash])

  const close = () => {
    if (st.phase !== 'success') api.loginCancel().catch(() => {})
    onClose()
  }
  const connect = async () => {
    if (!code.trim()) return
    setBusy(true)
    const r = await api.loginCode(code.trim()).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    if (!r.ok) onFlash?.(r)
    else setCode('')
  }
  const copyUrl = async () => onFlash?.((await copyText(st.url)) ? { ok: true, msg: 'link copiado' } : { ok: false, msg: 'não consegui copiar — selecione o link e copie' })
  const key = (k) => api.loginKey(k).catch(() => {})

  const phase = st.phase || 'idle'
  const working = ['idle', 'starting', 'method', 'code-sent'].includes(phase)
  return (
    <Modal title="Conectar conta do Claude" icon={LogIn} onClose={close} wide>
      <div className="mb-4 flex items-center gap-2 text-sm">
        {working && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
        {phase === 'success' && <CheckCircle2 className="h-4 w-4 text-emerald-300" />}
        {(phase === 'error' || phase === 'attention') && <AlertTriangle className="h-4 w-4 text-amber-300" />}
        <span className={phase === 'success' ? 'text-emerald-300' : phase === 'error' ? 'text-rose-300' : 'text-slate-200'}>{STEP_TEXT[phase] || phase}</span>
        {st.msg && phase !== 'success' && <span className="text-xs text-slate-500">— {st.msg}</span>}
      </div>

      {st.url && phase !== 'success' && (
        <div className="space-y-3">
          <div className="rounded-xl bg-primary/5 p-3 ring-1 ring-primary/20">
            <div className="mb-2 text-xs font-medium text-primary">1. Abra o link e autorize com a sua conta Claude (Pro/Max/Team/Enterprise)</div>
            <div className="flex flex-wrap gap-2">
              <a href={st.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary">
                <ExternalLink className="h-4 w-4" /> Abrir link de autorização
              </a>
              <Btn onClick={copyUrl}>
                <Copy className="h-4 w-4" /> Copiar link
              </Btn>
            </div>
            <code className="mt-2 block max-h-24 select-all overflow-auto break-all rounded-lg bg-background px-2.5 py-2 font-mono text-[11px] text-sky-300">{st.url}</code>
          </div>
          <div className="rounded-xl bg-sidebar p-3 border">
            <div className="mb-2 text-xs font-medium text-slate-300">2. Cole o código que aparece depois de autorizar</div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') connect()
                }}
                autoFocus
                placeholder="código de autorização"
                className={`min-w-0 flex-1 font-mono ${inputCls} px-3 py-2`}
              />
              <Btn variant="accent" busy={busy || phase === 'code-sent'} disabled={!code.trim()} onClick={connect}>
                <Link2 className="h-4 w-4" /> Conectar
              </Btn>
            </div>
          </div>
        </div>
      )}

      {phase === 'success' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-emerald-500/10 p-4 text-sm text-emerald-100 ring-1 ring-emerald-500/25">
          <CheckCircle2 className="h-5 w-5 text-emerald-300" /> Login salvo em <code>~/.claude</code> — vale para todos os projetos e persiste entre deploys.
          <Btn variant="accent" className="ml-auto" onClick={onClose}>
            Fechar
          </Btn>
        </div>
      )}
      {phase === 'error' && (
        <Btn variant="accent" busy={busy} onClick={begin}>
          <RefreshCw className="h-4 w-4" /> Tentar de novo
        </Btn>
      )}

      {phase !== 'success' && (
        <div className="mt-4">
          <button type="button" onClick={() => setShowScreen((v) => !v)} className="text-xs text-slate-500 hover:text-slate-300">
            {showScreen ? '▾ esconder' : '▸ ver'} a tela do Claude
          </button>
          {showScreen && (
            <>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2.5 font-mono text-[11px] leading-snug text-slate-300">{st.screen || '…'}</pre>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  ['↑', 'Up'],
                  ['↓', 'Down'],
                  ['Enter', 'Enter'],
                  ['Esc', 'Escape'],
                  ['1', '1'],
                  ['2', '2'],
                ].map(([l, k]) => (
                  <button key={k} type="button" onClick={() => key(k)} className="rounded-md bg-accent px-2.5 py-1 font-mono text-xs text-slate-300 border hover:bg-secondary hover:text-white">
                    {l}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
