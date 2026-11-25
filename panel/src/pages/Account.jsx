import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { UserRound, LogOut, LogIn, Check, ExternalLink, SquareTerminal, ShieldCheck, ShieldOff, Smartphone, Monitor, Trash2, Tag, ArrowUpCircle, CheckCircle2, AlertTriangle, RefreshCw, Loader2, Copy, Link2 } from 'lucide-react'
import QRCode from 'qrcode'
import { copyText } from '../lib/clipboard.js'
import { Btn, Modal, Card, Dot, inputCls, Skeleton, InlineConfirm } from '../components/ui.jsx'
import { fmtAgo, fmtDate } from '../lib/format.js'
import * as api from '../api.js'
import { UsageDetails } from '../components/UsageLimits.jsx'
import { t } from '../lib/i18n.js'
import { TR } from '../lib/i18n-rich.jsx'

export default function Account({ data, onFlash, refresh }) {
  const login = data.login || { logged: false, account: '', org: '', method: '' }
  // /account?login=1 (the Dashboard's "logged out — click to log in" link) opens the login at once
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
              <span className={`min-w-0 truncate text-sm text-foreground ${login.logged && login.account ? 'font-mono' : ''}`}>{login.logged ? login.account || t('acc.connected') : t('acc.none')}</span>
            </div>
            {login.org && <div className="mt-1.5 text-sm text-muted-foreground">{t('acc.org', { org: login.org })}</div>}
            <div className="mt-1.5 font-mono text-xs text-muted-foreground">
              {t('acc.method')} {login.method || '—'} · {data.version || '?'}
            </div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {login.logged ? (
            confirmLogout ? (
              <InlineConfirm text={t('acc.logoutConfirm')} onYes={doLogout} onNo={() => setConfirmLogout(false)} busy={busy} />
            ) : (
              <>
                <Btn variant="danger" onClick={() => setConfirmLogout(true)} className="px-4 py-2 text-sm">
                  <LogOut className="h-4 w-4" /> {t('acc.logout')}
                </Btn>
                <Btn onClick={() => setShowLogin(true)} className="px-4 py-2 text-sm">
                  <LogIn className="h-4 w-4" /> {t('acc.switch')}
                </Btn>
              </>
            )
          ) : (
            <Btn variant="accent" onClick={() => setShowLogin(true)} className="px-4 py-2 text-sm">
              <LogIn className="h-4 w-4" /> {t('acc.connect')}
            </Btn>
          )}
          <Link to="/terminal/shell" className="inline-flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent">
            <SquareTerminal className="h-4 w-4" /> {t('acc.openTerminal')}
          </Link>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          <TR k="acc.oauthInfo" />
        </p>
      </Card>

      <UsageDetails />
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

// Claude Code version: current x latest on npm, outdated warning and update button
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
        <Btn size="sm" variant="ghost" onClick={load} title={t('acc.checkAgain')}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Btn>
      }
    >
      {!h ? (
        <Skeleton className="h-16" />
      ) : (
        <>
          {c.updateAvailable && (
            <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-100 ring-1 ring-amber-500/30" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
              <span>
                <TR k="acc.outdated" vars={{ cur: c.currentNum, latest: c.latest }} />
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent border">
                <Tag className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="text-sm text-foreground">
                  {t('acc.installed')} <code className="font-mono text-xs text-foreground">{c.current || '?'}</code>
                </div>
                <div className="font-mono text-xs text-muted-foreground">{t('acc.npmLatest')} {c.latest ? <code>{c.latest}</code> : <span className="font-sans text-amber-600 dark:text-amber-300">{t('acc.npmFail')}</span>}</div>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {c.updateAvailable ? (
                <Btn variant="accent" busy={busy} onClick={update} title="sudo npm i -g @anthropic-ai/claude-code@latest">
                  <ArrowUpCircle className="h-4 w-4" /> {t('acc.updateTo', { v: c.latest })}
                </Btn>
              ) : c.latest ? (
                <span className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" /> {t('dash.upToDate')}
                </span>
              ) : (
                <Btn variant="ghost" busy={busy} onClick={update}>
                  <ArrowUpCircle className="h-4 w-4" /> {t('acc.forceUpdate')}
                </Btn>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <TR k="acc.updateInfo" />
          </p>
          {out && <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-background p-2 font-mono text-[11px] text-muted-foreground">{out}</pre>}
        </>
      )}
    </Card>
  )
}

// 2FA (TOTP): turn on with QR + code, turn off with code
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
    <Card title={t('tfa.title')} subtitle={st?.enabled ? t('tfa.since', { d: fmtDate(st.enabledAt) }) : t('tfa.off')}>
      {!st ? (
        <Skeleton className="h-16" />
      ) : st.enabled ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-300">
            <ShieldCheck className="h-5 w-5" /> <span><TR k="tfa.on" /></span>
          </span>
          {disabling ? (
            <span className="ml-auto inline-flex items-center gap-2">
              {codeInput}
              <Btn variant="danger" busy={busy} disabled={code.replace(/\s/g, '').length !== 6} onClick={disable}>
                <ShieldOff className="h-4 w-4" /> {t('tfa.confirmOff')}
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => {
                  setDisabling(false)
                  setCode('')
                }}
              >
                {t('common.cancel')}
              </Btn>
            </span>
          ) : (
            <Btn variant="ghost" className="ml-auto" onClick={() => setDisabling(true)}>
              <ShieldOff className="h-4 w-4" /> {t('tfa.disable')}
            </Btn>
          )}
        </div>
      ) : setup ? (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="shrink-0 rounded-xl bg-white p-3 border">
            <img src={setup.qr} alt={t('tfa.qrAlt')} className="h-[200px] w-[200px] rounded-lg" />
          </div>
          <div className="min-w-0 flex-1 space-y-3 text-sm text-foreground/80">
            <p>{t('tfa.step1')}</p>
            <code className="block break-all rounded-lg bg-background px-3 py-2 font-mono text-xs text-foreground">{setup.secret}</code>
            <p>{t('tfa.step2')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {codeInput}
              <Btn variant="accent" busy={busy} disabled={code.replace(/\s/g, '').length !== 6} onClick={enable}>
                <Check className="h-4 w-4" /> {t('tfa.enable')}
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => {
                  setSetup(null)
                  setCode('')
                }}
              >
                {t('common.cancel')}
              </Btn>
            </div>
            <p className="text-xs text-amber-300/90">
              <TR k="tfa.keep" />
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Dot on={false} /> {t('tfa.warn')}
          </span>
          <Btn variant="accent" className="ml-auto" busy={busy} onClick={start}>
            <ShieldCheck className="h-4 w-4" /> {t('tfa.enable')}
          </Btn>
        </div>
      )}
    </Card>
  )
}

// Active panel sessions: list, end one, end all the others
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
      title={t('ses.title')}
      subtitle={list ? t('ses.count', { n: list.length }) : ''}
      actions={
        list &&
        list.length > 1 &&
        (confirmAll ? (
          <InlineConfirm text={t('ses.revokeAllQ')} onYes={revokeAll} onNo={() => setConfirmAll(false)} busy={busy === 'all'} />
        ) : (
          <Btn size="sm" variant="ghost" onClick={() => setConfirmAll(true)}>
            <LogOut className="h-3.5 w-3.5" /> {t('ses.revokeAll')}
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
              {/iPhone|iPad|Android/.test(s.ua) ? <Smartphone className="h-4 w-4 text-muted-foreground" /> : <Monitor className="h-4 w-4 text-muted-foreground" />}
              <div className="min-w-0 flex-1">
                <div className="text-foreground">
                  {uaShort(s.ua)} {s.current && <span className="ml-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary-300">{t('ses.current')}</span>}
                </div>
                <div className="font-mono text-xs text-muted-foreground">
                  IP {s.ip || '?'} · último acesso {fmtAgo(s.last * 1000)} · login {fmtDate(s.iat * 1000)} · expira {fmtDate(s.exp * 1000)}
                </div>
              </div>
              {!s.current && (
                <Btn size="sm" variant="danger" busy={busy === s.id} onClick={() => revoke(s.id)}>
                  <Trash2 className="h-3.5 w-3.5" /> {t('ses.revoke')}
                </Btn>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// GUIDED Claude login: the server runs `claude` in a wide tmux session (cr-login) and answers
// ALL the screens by itself (first run, login method, post-login). Here the owner only sees: progress ->
// link (Open/Copy) + code field -> success. The raw screen only shows up as the LAST resort
// ("attention" phase: an unknown screen the panel could not get past).
const STEP_TEXT = {
  idle: 'login.phase.idle',
  starting: 'login.phase.starting',
  url: 'login.phase.url',
  'code-sent': 'login.phase.code-sent',
  finishing: 'login.phase.finishing',
  success: 'login.phase.success',
  error: 'login.phase.error',
  attention: 'login.phase.attention',
}
// screens the panel passes by itself (the id comes from the SCREENS table in server/login.js)
const SCREEN_TEXT = {
  theme: 'login.screen.theme',
  'login-method': 'login.screen.login-method',
  'api-key': 'login.screen.api-key',
  'login-command': 'login.screen.login-command',
  'login-success': 'login.screen.login-success',
  'security-notes': 'login.screen.security-notes',
  'terminal-setup': 'login.screen.terminal-setup',
  'trust-folder': 'login.screen.trust-folder',
  'bypass-warning': 'login.screen.bypass-warning',
  'press-enter': 'login.screen.press-enter',
}
const STEPS = ['login.step.prepare', 'login.step.authorize', 'login.step.finish']
const stepIndex = (phase) => (phase === 'url' ? 1 : ['code-sent', 'finishing'].includes(phase) ? 2 : phase === 'success' ? 3 : 0)
const LOGIN_KEYS = [
  ['↑', 'Up'],
  ['↓', 'Down'],
  ['Enter', 'Enter'],
  ['Esc', 'Escape'],
  ['1', '1'],
  ['2', '2'],
]

function LoginModal({ onClose, onFlash }) {
  const [st, setSt] = useState({ phase: 'idle', url: '', msg: '', screen: '' })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
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
      onFlash?.({ ok: true, msg: t('login.connectedFlash') })
    }
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
  const copyUrl = async () => {
    const done = await copyText(st.url)
    setCopied(done)
    if (done) setTimeout(() => setCopied(false), 2000)
    else onFlash?.({ ok: false, msg: t('login.copyFail') })
  }
  const key = (k) => api.loginKey(k).catch(() => {})

  const phase = st.phase || 'idle'
  const working = ['idle', 'starting', 'code-sent', 'finishing'].includes(phase)
  const showLink = st.url && ['url', 'code-sent'].includes(phase)
  const idx = stepIndex(phase)
  const detail = working ? (SCREEN_TEXT[st.step] ? t(SCREEN_TEXT[st.step]) : '') : ''
  return (
    <Modal title={t('login.modalTitle')} icon={LogIn} onClose={close} wide dismissible={false}>
      <ol className="mb-4 flex items-center gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                i < idx ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300' : i === idx ? 'bg-primary/20 text-primary ring-1 ring-primary/40' : 'bg-secondary text-muted-foreground'
              }`}
            >
              {i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className={i === idx ? 'text-foreground' : 'text-muted-foreground'}>{t(label)}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        ))}
      </ol>

      <div className="mb-4 flex items-start gap-2 text-sm">
        {working && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />}
        {phase === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />}
        {(phase === 'error' || phase === 'attention') && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />}
        <div className="min-w-0">
          <div className={phase === 'success' ? 'text-emerald-600 dark:text-emerald-300' : phase === 'error' ? 'text-rose-600 dark:text-rose-300' : 'text-foreground'}>{STEP_TEXT[phase] ? t(STEP_TEXT[phase]) : phase}</div>
          {detail && <div className="text-xs text-muted-foreground">{detail}…</div>}
          {st.msg && phase !== 'success' && <div className="text-xs text-muted-foreground">{st.msg}</div>}
        </div>
      </div>

      {showLink && (
        <div className="space-y-3">
          <div className="rounded-xl bg-primary/5 p-3 ring-1 ring-primary/20">
            <div className="mb-2 text-xs font-medium text-primary">{t('login.s1')}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <a
                href={st.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base font-medium text-primary-foreground hover:bg-primary/90"
              >
                <ExternalLink className="h-5 w-5" /> {t('login.openLink')}
              </a>
              <button
                type="button"
                onClick={copyUrl}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border bg-secondary px-4 py-3 text-base font-medium text-foreground hover:bg-accent"
              >
                {copied ? <Check className="h-5 w-5 text-emerald-600 dark:text-emerald-300" /> : <Copy className="h-5 w-5" />} {copied ? t('login.copied') : t('login.copyLink')}
              </button>
            </div>
            <code className="mt-2 block max-h-16 select-all overflow-auto break-all rounded-lg bg-background px-2.5 py-2 font-mono text-[11px] text-sky-600 dark:text-sky-300">{st.url}</code>
          </div>
          <div className="rounded-xl border bg-sidebar p-3">
            <div className="mb-2 text-xs font-medium text-foreground/80">{t('login.s2')}</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') connect()
                }}
                placeholder={t('login.codePh')}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={`min-w-0 flex-1 font-mono ${inputCls} px-3 py-3 text-base`}
              />
              <Btn variant="accent" busy={busy || phase === 'code-sent'} disabled={!code.trim()} onClick={connect} className="min-h-12 justify-center px-5 text-base">
                <Link2 className="h-4 w-4" /> {t('login.connect')}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {phase === 'success' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-100 ring-1 ring-emerald-500/25">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" /> <span><TR k="login.done" /></span>
          <Btn variant="accent" className="ml-auto" onClick={onClose}>
            {t('common.close')}
          </Btn>
        </div>
      )}
      {phase === 'error' && (
        <Btn variant="accent" busy={busy} onClick={begin} className="min-h-12 px-5 text-base">
          <RefreshCw className="h-4 w-4" /> {t('login.tryAgain')}
        </Btn>
      )}

      {/* last resort: an unknown screen the panel did not get past by itself */}
      {(phase === 'attention' || (phase === 'error' && st.screen)) && (
        <div className="mt-4">
          {phase === 'attention' && <div className="mb-2 text-xs text-muted-foreground">{t('login.attention')}</div>}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2.5 font-mono text-[11px] leading-snug text-foreground/80">{st.screen || '…'}</pre>
          {phase === 'attention' && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {LOGIN_KEYS.map(([l, k]) => (
                <button key={k} type="button" onClick={() => key(k)} className="min-h-10 min-w-10 rounded-md border bg-accent px-3 py-1.5 font-mono text-sm text-foreground/80 hover:bg-secondary hover:text-foreground">
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
