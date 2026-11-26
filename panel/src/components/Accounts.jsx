import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { UserRound, UserPlus, LogIn, LogOut, Pencil, KeyRound, Trash2, SquareTerminal } from 'lucide-react'
import { Btn, Card, Dot, inputCls, Skeleton, InlineConfirm, InlineInput, useConfirm } from './ui.jsx'
import { LimitBar, useLimits } from './UsageLimits.jsx'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'

// Several Claude accounts (server/accounts.js): listed on the Account page, chosen per project in
// "Configure" (switched by hand only). Kept in this file so the Dashboard only imports two small pieces.

export const accountLabel = (a) => (a ? a.label || (a.isDefault ? t('acct.defaultLabel') : a.id) : '')

// plan windows of one account from the limits snapshot (default = `claude`, the others = `accounts[id]`)
export function usageOf(snap, id) {
  if (!snap) return null
  return id === 'default' ? snap.claude || null : (snap.accounts || {})[id] || null
}

const pct5h = (u) => {
  const w = u && u.status === 'ok' && (u.windows || []).find((x) => x.id === 'five_hour')
  return w ? Math.round(w.percent) : null
}

// Account page: every account with its login, usage and the projects that use it + "Add account"
export function AccountsCard({ version, onFlash, onLogin, reloadKey, children }) {
  const [list, setList] = useState(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState('')
  const { snap } = useLimits()
  const load = useCallback(() => api.accounts().then((r) => { if (r && r.ok) setList(r.accounts) }).catch(() => {}), [])
  useEffect(() => { load() }, [load, reloadKey])
  const act = useCallback(async (key, fn) => {
    setBusy(key)
    const r = await fn().catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    onFlash?.(r)
    load()
    return r
  }, [onFlash, load])
  const add = async () => {
    if (!label.trim()) return
    const r = await act('create', () => api.accountCreate(label.trim()))
    if (r && r.ok) {
      setLabel('')
      onLogin?.(r.id) // a new account starts logged out: go straight to its login
    }
  }
  return (
    <Card title={t('acct.title')} subtitle={t('acct.subtitle', { v: version || '?' })}>
      {!list ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="space-y-3" data-testid="accounts-list">
          {list.map((a) => (
            <AccountRow key={a.id} a={a} usage={usageOf(snap, a.id)} thresholds={snap && snap.thresholds} busy={busy} act={act} onLogin={onLogin} />
          ))}
        </ul>
      )}
      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input data-testid="account-new-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder={t('acct.newPh')} className={`min-w-0 flex-1 ${inputCls}`} />
        <Btn type="submit" variant="accent" busy={busy === 'create'} disabled={!label.trim()} className="justify-center">
          <UserPlus className="h-4 w-4" /> {t('acct.add')}
        </Btn>
      </form>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1">{t('acct.hint')}</span>
        <Link to="/terminal/shell" className="inline-flex items-center gap-1.5 text-primary hover:underline">
          <SquareTerminal className="h-3.5 w-3.5" /> {t('acc.openTerminal')}
        </Link>
      </div>
      {children}
    </Card>
  )
}

// one account: login state, 5h/weekly bars, projects; actions log in / token / rename / log out / remove
function AccountRow({ a, usage, thresholds, busy, act, onLogin }) {
  const [mode, setMode] = useState('') // '' | rename | token | logout | remove
  const [token, setToken] = useState('')
  const name = accountLabel(a)
  const wins = usage && usage.status === 'ok' ? (usage.windows || []).slice(0, 2) : []
  const used = a.projects || []
  const done = (r) => { if (r && r.ok) { setMode(''); setToken('') } }
  return (
    <li data-testid="account-row" data-account={a.id} className="min-w-0 rounded-xl border bg-sidebar p-3 sm:p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent ring-1 ring-primary/30">
          <UserRound className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-foreground" data-testid="account-label">{name}</span>
            {a.isDefault && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t('acct.defaultBadge')}</span>}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
            <Dot on={a.logged} />
            <span className={`min-w-0 truncate ${a.logged && a.account ? 'font-mono text-foreground/80' : 'text-muted-foreground'}`}>
              {a.logged ? a.account || (a.method === 'token' ? t('acct.viaToken') : t('acc.connected')) : t('acct.notLogged')}
            </span>
            {a.plan && <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">{a.plan}</span>}
          </div>
          {a.org && <div className="mt-0.5 truncate text-xs text-muted-foreground">{t('acc.org', { org: a.org })}</div>}
        </div>
      </div>

      {wins.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {wins.map((w) => <LimitBar key={w.id} {...w} thresholds={thresholds} stale={usage.stale} />)}
        </div>
      )}
      {usage && usage.status !== 'ok' && usage.status !== 'pending' && usage.status !== 'not_logged_in' && usage.message && (
        <div className="mt-2 text-xs text-amber-700 dark:text-amber-200">{usage.message}</div>
      )}
      <div className="mt-2 text-xs text-muted-foreground" data-testid="account-projects">
        {used.length ? t('acct.usedBy', { names: used.join(', ') }) : t('acct.unused')}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mode === 'rename' ? (
          <InlineInput initial={a.label || ''} placeholder={t('acct.newPh')} busy={busy === 'rename:' + a.id} onCancel={() => setMode('')}
            onSubmit={async (v) => done(await act('rename:' + a.id, () => api.accountRename(a.id, v)))} className="max-w-full" />
        ) : mode === 'token' ? (
          <form className="flex w-full flex-col gap-2 sm:flex-row" onSubmit={async (e) => { e.preventDefault(); if (token.trim()) done(await act('token:' + a.id, () => api.accountToken(a.id, token.trim()))) }}>
            <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('acct.tokenPh')} className={`min-w-0 flex-1 font-mono ${inputCls}`} />
            <div className="flex gap-2">
              <Btn type="submit" variant="accent" busy={busy === 'token:' + a.id} disabled={!token.trim()}>{t('common.save')}</Btn>
              {a.hasToken && <Btn variant="ghost" onClick={async () => done(await act('token:' + a.id, () => api.accountToken(a.id, '')))}>{t('acct.tokenRemove')}</Btn>}
              <Btn variant="ghost" onClick={() => { setMode(''); setToken('') }}>{t('common.cancel')}</Btn>
            </div>
          </form>
        ) : mode === 'logout' ? (
          <InlineConfirm text={t('acct.logoutQ', { name })} busy={busy === 'logout:' + a.id} onNo={() => setMode('')}
            onYes={async () => done(await act('logout:' + a.id, () => api.accountLogout(a.id)))} />
        ) : mode === 'remove' ? (
          <InlineConfirm text={t('acct.removeQ', { name })} busy={busy === 'remove:' + a.id} onNo={() => setMode('')}
            onYes={async () => done(await act('remove:' + a.id, () => api.accountRemove(a.id)))} />
        ) : (
          <>
            <Btn variant={a.logged ? 'default' : 'accent'} size="sm" onClick={() => onLogin?.(a.id)}>
              <LogIn className="h-3.5 w-3.5" /> {a.logged ? t('acc.switch') : t('acct.login')}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setMode('token')} title={t('acct.tokenTitle')}>
              <KeyRound className="h-3.5 w-3.5" /> {t('acct.token')}
            </Btn>
            <Btn size="sm" variant="ghost" onClick={() => setMode('rename')}>
              <Pencil className="h-3.5 w-3.5" /> {t('acct.rename')}
            </Btn>
            {a.logged && (
              <Btn size="sm" variant="ghost" onClick={() => setMode('logout')}>
                <LogOut className="h-3.5 w-3.5" /> {t('acc.logout')}
              </Btn>
            )}
            {!a.isDefault && (
              <Btn size="sm" variant="ghost" disabled={used.length > 0} onClick={() => setMode('remove')} title={used.length ? t('acct.removeInUse') : ''}>
                <Trash2 className="h-3.5 w-3.5" /> {t('acct.remove')}
              </Btn>
            )}
          </>
        )}
      </div>
    </li>
  )
}

// "Configure project" drawer: which Claude account this project runs with. Changing it restarts the
// project's session (asks first: the running task is interrupted).
export function ProjectAccountSection({ p, accounts, onFlash, refresh }) {
  const [confirmEl, ask] = useConfirm()
  const [busy, setBusy] = useState(false)
  const { snap } = useLimits()
  const list = accounts && accounts.length ? accounts : [{ id: 'default', label: '', isDefault: true, logged: false }]
  const cur = p.account || 'default'
  const change = async (id) => {
    if (id === cur) return
    const a = list.find((x) => x.id === id)
    const yes = await ask(t(p.enabled === false ? 'acct.switchQOff' : 'acct.switchQ', { name: p.name, label: accountLabel(a) }), { title: t('acct.switchTitle'), yes: t('acct.switchYes'), icon: UserRound })
    if (!yes) return
    setBusy(true)
    const r = await api.setProjectAccount(p.name, id).catch((e) => ({ ok: false, msg: e.message }))
    setBusy(false)
    onFlash?.(r)
    refresh?.()
  }
  const optText = (a) => {
    const u = pct5h(usageOf(snap, a.id))
    return [accountLabel(a), a.logged ? a.account || '' : t('acct.notLogged'), u !== null ? t('acct.opt5h', { p: u }) : ''].filter(Boolean).join(' · ')
  }
  return (
    <section className="rounded-xl border border-border bg-sidebar p-4">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <UserRound className="h-3.5 w-3.5" /> {t('acct.section')}
      </h4>
      <p className="mb-2 text-xs text-muted-foreground">{t('acct.sectionHint')}</p>
      <select data-testid="project-account" value={cur} disabled={busy} onChange={(e) => change(e.target.value)} className={`w-full max-w-full ${inputCls}`}>
        {!list.some((a) => a.id === cur) && <option value={cur}>{cur}</option>}
        {list.map((a) => (
          <option key={a.id} value={a.id}>{optText(a)}</option>
        ))}
      </select>
      <Link to="/accounts" className="mt-2 inline-block text-xs text-primary hover:underline">{t('acct.manage')}</Link>
      {confirmEl}
    </section>
  )
}

// project card: which account, only when it is not the default one
export function AccountBadge({ p, accounts }) {
  if (!p.account || p.account === 'default') return null
  const a = (accounts || []).find((x) => x.id === p.account)
  const name = a ? accountLabel(a) : p.account
  return (
    <span data-testid="account-badge" title={t('acct.badgeTitle', { label: name })} className="inline-flex min-w-0 max-w-[12rem] items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
      <UserRound className="h-3 w-3 shrink-0" /> <span className="truncate">{name}</span>
    </span>
  )
}
