import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Settings, Cpu, Radio, Bell, BellRing, BellOff, Eye, EyeOff, ShieldCheck, FolderCog, Info, Save, PauseCircle } from 'lucide-react'
import { Btn, Card, Skeleton, inputCls } from '../components/ui.jsx'
import * as api from '../api.js'

function Toggle({ on, onChange, label, hint, icon: Icon, busy }) {
  return (
    <button type="button" disabled={busy} onClick={() => onChange(!on)} className={`flex w-full items-center gap-3 rounded-xl border bg-accent p-3 text-left transition hover:border-primary/30 disabled:opacity-50 ${on ? 'border-success/30' : 'border-border'}`}>
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

// /settings — defaults do panel.json, notificacoes, ambiente (mascarado), caminhos
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
      <Card title="Notificações" subtitle="quando o Claude terminar ou perguntar algo">
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle icon={Bell} on={s.settings.notifications !== false} busy={busy === 'notifications'} onChange={(v) => setPref('notifications', v)} label="Avisos no painel" hint="toast na tela quando um projeto muda de estado" />
          <button type="button" onClick={onToggleNotif} className={`flex w-full items-center gap-3 rounded-xl border bg-accent p-3 text-left transition hover:border-primary/30 ${notif === 'granted' ? 'border-success/30' : 'border-border'}`}>
            <NotifIcon className={`h-4 w-4 shrink-0 ${notif === 'granted' ? 'text-success' : 'text-muted-foreground'}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">Notificações do navegador</div>
              <div className="text-xs text-muted-foreground">{notif === 'granted' ? 'ativas — chegam mesmo com o painel em segundo plano' : notif === 'denied' ? 'bloqueadas nas permissões do site' : 'clique para permitir'}</div>
            </div>
          </button>
          <Toggle icon={Cpu} on={s.settings.notifyDone !== false} busy={busy === 'notifyDone'} onChange={(v) => setPref('notifyDone', v)} label="“Claude terminou”" hint="quando fica ocioso após ≥5s trabalhando" />
          <Toggle icon={ShieldCheck} on={s.settings.notifyPrompt !== false} busy={busy === 'notifyPrompt'} onChange={(v) => setPref('notifyPrompt', v)} label="“Claude está esperando você”" hint="pergunta / pedido de permissão pendente" />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Instale o painel como app no celular (menu do navegador → “Adicionar à tela inicial”) para receber as notificações lá.</p>
      </Card>

      <Card title="Defaults para projetos novos" subtitle="panel.json → defaults (projetos sem config própria)">
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle icon={Cpu} on={!!s.defaults.autoStartClaude} busy={busy === 'autoStartClaude'} onChange={(v) => setDefault('autoStartClaude', v)} label="Iniciar o Claude na sessão" hint="autoStartClaude" />
          <Toggle icon={Radio} on={!!s.defaults.autoRemote} busy={busy === 'autoRemote'} onChange={(v) => setDefault('autoRemote', v)} label="Religar o remote-control" hint="autoRemote" />
        </div>
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-border bg-accent p-3">
          <label className="text-xs text-muted-foreground">
            <span className="mb-1 flex items-center gap-1.5 text-foreground/80">
              <PauseCircle className="h-4 w-4 text-primary" /> Pausar Claude parado após (horas, 0 = nunca)
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
            <Save className="h-3.5 w-3.5" /> Salvar
          </Btn>
          <span className="text-[11px] text-muted-foreground">pausa o Claude sozinho quando fica ocioso por tempo demais (libera CPU/memória)</span>
        </div>
      </Card>

      <Card title="Segurança" subtitle={`sessão do painel válida por ${s.sessionDays} dias`}>
        <div className="flex flex-wrap items-center gap-3 text-sm text-foreground/80">
          <ShieldCheck className={`h-5 w-5 ${s.twofa.enabled ? 'text-emerald-600 dark:text-emerald-300' : 'text-amber-600 dark:text-amber-300'}`} />
          <span>
            2FA {s.twofa.enabled ? 'ativo' : 'desativado'} · sessões e 2FA em{' '}
            <Link to="/account" className="text-primary hover:underline">
              Conta
            </Link>
          </span>
        </div>
      </Card>

      <Card
        title="Ambiente do serviço"
        subtitle="somente leitura — altere no EasyPanel → Environment e faça redeploy"
        actions={
          <Btn size="sm" variant="ghost" onClick={() => setShowEnv((v) => !v)}>
            {showEnv ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {showEnv ? 'ocultar' : 'mostrar'}
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
                        <span className="text-amber-600 dark:text-amber-300" title="valor sensível — mascarado">
                          {e.value || '(vazio)'}
                        </span>
                      ) : (
                        e.value || <span className="text-muted-foreground/70">(vazio)</span>
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
          <Info className="mt-0.5 h-3 w-3 shrink-0" /> Valores sensíveis (<code>PANEL_PASSWORD</code>, <code>GH_TOKEN</code>) nunca saem do servidor por inteiro.
        </p>
      </Card>
      <div className="hidden">
        <Settings />
      </div>
    </div>
  )
}
