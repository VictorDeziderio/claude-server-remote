import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Settings, Cpu, Radio, Bell, BellRing, BellOff, Eye, EyeOff, ShieldCheck, FolderCog, Info, Save, PauseCircle, RotateCw, ArrowUpCircle } from 'lucide-react'
import { Btn, Card, Skeleton, inputCls } from '../components/ui.jsx'
import * as api from '../api.js'
import { t, getLang, setLang, languages } from '../lib/i18n.js'
import { TR } from '../lib/i18n-rich.jsx'

function Toggle({ on, onChange, label, hint, icon: Icon, busy }) {
  return (
    <button type="button" disabled={busy} onClick={() => onChange(!on)} className={`flex w-full items-center gap-3 rounded-lg border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/70 disabled:opacity-50`}>
      {Icon && <Icon className={`h-4 w-4 shrink-0 ${on ? 'text-success' : 'text-muted-foreground'}`} />}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <span className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition ${on ? 'bg-success ' : 'bg-secondary'}`}>
        <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition ${on ? 'translate-x-4' : ''}`} />
      </span>
    </button>
  )
}

// /settings — panel.json defaults, notifications, environment (masked), paths
// "Update the panel" (server/update.js): only when DEPLOY_WEBHOOK_URL is set. "When idle" waits for
// every project to finish its task; interrupted ones continue by themselves after the restart.
function UpdateCard({ onFlash }) {
  const [u, setU] = useState(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(() => api.updateStatus().then(setU).catch(() => {}), [])
  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id) }, [load])
  if (!u || !u.configured) return null
  const go = async (mode) => {
    setBusy(mode)
    const r = await api.updateRequest(mode).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    onFlash?.(r)
    load()
  }
  return (
    <Card title={t('settings.update')} subtitle={t('settings.updateSub')}>
      <div className="space-y-3 text-sm" data-testid="update-card">
        <p className="text-xs text-muted-foreground">
          {u.waiting ? t('settings.updateWaiting', { names: u.busy.join(', ') || '—' }) : u.busy.length ? t('settings.updateBusy', { names: u.busy.join(', ') }) : t('settings.updateIdle')}
        </p>
        <div className="flex flex-wrap gap-2">
          {u.waiting
            ? <Btn variant="ghost" busy={busy === 'cancel'} onClick={() => go('cancel')}>{t('common.cancel')}</Btn>
            : <Btn variant="accent" busy={busy === 'idle'} onClick={() => go('idle')}><ArrowUpCircle className="h-3.5 w-3.5" /> {t('settings.updateIdleBtn')}</Btn>}
          {!u.waiting && <Btn variant="ghost" busy={busy === 'now'} onClick={() => go('now')}>{t('settings.updateNowBtn')}</Btn>}
        </div>
      </div>
    </Card>
  )
}

export default function SettingsPage({ onFlash, refresh, notif, onToggleNotif }) {
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState('')
  const [showEnv, setShowEnv] = useState(false)
  const [idleHours, setIdleHours] = useState('0')
  const idleTouched = useRef(false)
  const load = useCallback(
    () =>
      api
        .settings()
        .then((r) => {
          if (r.ok) setS(r)
        })
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (s && !idleTouched.current) setIdleHours(String(s.defaults.idlePauseHours ?? 0))
  }, [s])

  const setDefault = async (k, v) => {
    setBusy(k)
    const r = await api.setDefaults({ [k]: v }).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    onFlash?.(r)
    load()
    refresh?.()
  }
  const setPref = async (k, v) => {
    setBusy(k)
    const r = await api.setSettings({ [k]: v }).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    onFlash?.(r)
    load()
    refresh?.()
  }

  if (!s)
    return (
      <div className="space-y-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    )
  const NotifIcon = notif === 'granted' ? BellRing : notif === 'denied' ? BellOff : Bell

  return (
    <div className="space-y-5">
      <UpdateCard onFlash={onFlash} />

      <Card title={t('settings.lang')} subtitle={t('settings.langSub')}>
        <select value={getLang()} onChange={(e) => setLang(e.target.value)} className={inputCls} aria-label={t('settings.lang')}>
          {languages().map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <p className="mt-2 text-[11px] text-muted-foreground">{t('settings.langHint')}</p>
      </Card>

      <Card title={t('settings.notif')} subtitle={t('settings.notifSub')}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle icon={Bell} on={s.settings.notifications !== false} busy={busy === 'notifications'} onChange={(v) => setPref('notifications', v)} label={t('settings.toasts')} hint={t('settings.toastsHint')} />
          <button type="button" onClick={onToggleNotif} className={`flex w-full items-center gap-3 rounded-lg border bg-muted/30 p-3 text-left transition-colors hover:bg-muted/70 border-border`}>
            <NotifIcon className={`h-4 w-4 shrink-0 ${notif === 'granted' ? 'text-success' : 'text-muted-foreground'}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">{t('settings.browserNotif')}</div>
              <div className="text-xs text-muted-foreground">{notif === 'granted' ? t('settings.browserOn') : notif === 'denied' ? t('settings.browserBlocked') : t('settings.browserAsk')}</div>
            </div>
          </button>
          <Toggle icon={Cpu} on={s.settings.notifyDone !== false} busy={busy === 'notifyDone'} onChange={(v) => setPref('notifyDone', v)} label={t('settings.notifyDone')} hint={t('settings.notifyDoneHint')} />
          <Toggle icon={ShieldCheck} on={s.settings.notifyPrompt !== false} busy={busy === 'notifyPrompt'} onChange={(v) => setPref('notifyPrompt', v)} label={t('settings.notifyPrompt')} hint={t('settings.notifyPromptHint')} />
          <Toggle icon={RotateCw} on={s.settings.autoResume !== false} busy={busy === 'autoResume'} onChange={(v) => setPref('autoResume', v)} label={t('settings.autoResume')} hint={t('settings.autoResumeHint')} />
          <Toggle icon={ArrowUpCircle} on={s.settings.autoUpdateClaude !== false} busy={busy === 'autoUpdateClaude'} onChange={(v) => setPref('autoUpdateClaude', v)} label={t('settings.autoUpdateClaude')} hint={t('settings.autoUpdateClaudeHint')} />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">{t('settings.installApp')}</p>
      </Card>

      <Card title={t('settings.defaults')} subtitle={t('settings.defaultsSub')}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle icon={Cpu} on={!!s.defaults.autoStartClaude} busy={busy === 'autoStartClaude'} onChange={(v) => setDefault('autoStartClaude', v)} label={t('settings.autoStart')} hint="autoStartClaude" />
          <Toggle icon={Radio} on={!!s.defaults.autoRemote} busy={busy === 'autoRemote'} onChange={(v) => setDefault('autoRemote', v)} label={t('settings.autoRemote')} hint="autoRemote" />
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-accent p-3">
          <label className="text-xs text-muted-foreground">
            <span className="mb-1 flex items-center gap-1.5 text-foreground/80">
              <PauseCircle className="h-4 w-4 text-primary" /> {t('settings.idlePause')}
            </span>
            <input
              type="number"
              min="0"
              step="1"
              value={idleHours}
              onChange={(e) => { idleTouched.current = true; setIdleHours(e.target.value) }}
              className={`mt-1 block w-28 ${inputCls}`}
            />
          </label>
          <Btn
            size="sm"
            variant="accent"
            busy={busy === 'idlePauseHours'}
            onClick={() => { idleTouched.current = false; setDefault('idlePauseHours', Math.max(0, parseInt(idleHours, 10) || 0)) }}
          >
            <Save className="h-3.5 w-3.5" /> {t('common.save')}
          </Btn>
          <span className="text-[11px] text-muted-foreground">{t('settings.idlePauseHint')}</span>
        </div>
      </Card>

      <Card title={t('settings.security')} subtitle={t('settings.securitySub', { n: s.sessionDays })}>
        <div className="flex flex-wrap items-center gap-3 text-sm text-foreground/80">
          <ShieldCheck className={`h-5 w-5 ${s.twofa.enabled ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300'}`} />
          <span>
            {s.twofa.enabled ? t('settings.twofaOn') : t('settings.twofaOff')}{' '}
            <Link to="/accounts" className="text-primary hover:underline">
              {t('nav.account')}
            </Link>
          </span>
        </div>
      </Card>

      <Card
        title={t('settings.env')}
        subtitle={t('settings.envSub')}
        actions={
          <Btn size="sm" variant="ghost" onClick={() => setShowEnv((v) => !v)}>
            {showEnv ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {showEnv ? t('common.hide') : t('common.show')}
          </Btn>
        }
      >
        {showEnv && (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <tbody className="text-foreground">
                {s.env.map((e) => (
                  <tr key={e.key} className="border-t border-border transition first:border-0 hover:bg-muted/50">
                    <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{e.key}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">
                      {e.secret ? (
                        <span className="text-amber-600 dark:text-amber-300" title={t('settings.secret')}>
                          {e.value || t('settings.empty')}
                        </span>
                      ) : (
                        e.value || <span className="text-muted-foreground/70">{t('settings.empty')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          {Object.entries(s.paths).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1">
              <FolderCog className="h-3 w-3 shrink-0" />
              <span>
                {k}: <code className="font-mono text-xs text-muted-foreground">{v}</code>
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" /> <span><TR k="settings.secretsInfo" /></span>
        </p>
      </Card>
      <div className="hidden">
        <Settings />
      </div>
    </div>
  )
}
