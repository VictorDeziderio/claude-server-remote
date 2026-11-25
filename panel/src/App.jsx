import { useEffect, useState, useCallback, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Loader2, Plus, RefreshCw } from 'lucide-react'
import Layout from './components/Layout.jsx'
import Login from './components/Login.jsx'
import { Btn, Toast, Skeleton } from './components/ui.jsx'
import useEvents from './hooks/useEvents.js'
import Dashboard from './pages/Dashboard.jsx'
import Report from './pages/Report.jsx'
import FilesPage from './pages/FilesPage.jsx'
import TerminalPage from './pages/TerminalPage.jsx'
import Account from './pages/Account.jsx'
import * as api from './api.js'

const HistoryPage = lazy(() => import('./pages/History.jsx'))
const LogsPage = lazy(() => import('./pages/Logs.jsx'))
const BackupPage = lazy(() => import('./pages/Backup.jsx'))
const SettingsPage = lazy(() => import('./pages/Settings.jsx'))
const NotificationsPage = lazy(() => import('./pages/Notifications.jsx'))

const Loading = () => <div className="flex h-40 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin text-primary" /> carregando…</div>
function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-40" />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-36" /><Skeleton className="h-36" />
    </div>
  )
}

export default function App() {
  const [data, setData] = useState(null)
  const [authed, setAuthed] = useState(null) // null = ainda nao sabemos
  const [flash, setFlash] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const [notifPerm, setNotifPerm] = useState(() => (typeof Notification !== 'undefined' ? Notification.permission : 'denied'))
  const [alerts, setAlerts] = useState([])
  const { pathname } = useLocation()

  // notificacoes (Claude terminou / esta esperando voce / alerta de saude da VM): toast
  // sempre + Notification do navegador se permitido
  const onNotify = useCallback((n) => {
    const s = (data && data.settings) || {}
    if (s.notifications === false) return
    if (n.kind === 'done' && s.notifyDone === false) return
    if (n.kind === 'prompt' && s.notifyPrompt === false) return
    const isAlert = n.kind === 'alert'
    if (isAlert) setAlerts((a) => [{ t: Date.now(), level: n.level, kind: n.alertKind, project: n.project, msg: `${n.title}${n.body ? ' — ' + n.body : ''}` }, ...a].slice(0, 50))
    setFlash({ ok: isAlert ? n.level !== 'error' && n.level !== 'critical' : n.kind !== 'prompt', msg: `${n.title}${n.body ? ' — ' + n.body : ''}` })
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try {
        const note = new Notification(n.title, { body: n.body, tag: 'cr-' + (n.name || n.project) + '-' + n.kind, icon: '/icon.svg' })
        note.onclick = () => { window.focus(); window.location.hash = ''; window.history.pushState({}, '', n.name ? '/terminal/' + encodeURIComponent(n.name) : '/dashboard'); window.dispatchEvent(new PopStateEvent('popstate')); note.close() }
      } catch { /* */ }
    }
  }, [data])
  const onUnauth = useCallback(() => { setAuthed(false); setData(null) }, [])
  const onState = useCallback((d) => { setAuthed(true); setData(d) }, [])
  const { live, activity, refresh } = useEvents({ enabled: authed === true, onState, onUnauth, onNotify })

  // primeira carga: descobre se esta autenticado
  useEffect(() => { refresh() }, [refresh])
  // alertas ja registrados no servidor (o SSE so traz os novos a partir de agora)
  useEffect(() => {
    if (authed !== true) return
    api.alerts().then((r) => { if (r.ok) setAlerts(r.alerts) }).catch(() => {})
  }, [authed])
  const clearAlerts = useCallback(() => { api.alertsClear().catch(() => {}); setAlerts([]) }, [])

  const doLogout = async () => { try { await api.logout() } catch { /* */ } setData(null); setAuthed(false) }
  const closeFlash = useCallback(() => setFlash(null), [])
  const toggleNotif = async () => {
    if (typeof Notification === 'undefined') return setFlash({ ok: false, msg: 'este navegador não suporta notificações' })
    if (Notification.permission === 'granted') return setFlash({ ok: true, msg: 'notificações já estão ativas — desative nas preferências do site no navegador, ou em Configurações' })
    if (Notification.permission === 'denied') return setFlash({ ok: false, msg: 'notificações bloqueadas no navegador — libere nas permissões do site' })
    const p = await Notification.requestPermission()
    setNotifPerm(p)
    setFlash({ ok: p === 'granted', msg: p === 'granted' ? 'notificações ativadas — você será avisado quando o Claude terminar ou perguntar algo' : 'permissão negada' })
  }

  if (authed === false) return <Login onSuccess={() => { setAuthed(true); refresh() }} />

  const isTerm = pathname.startsWith('/terminal')
  // aba aberta antes de um deploy: o servidor ja e outro build, mas este JS e o antigo
  // (modal de login velho, sem copiar-ao-selecionar...) -> avisa e oferece recarregar
  /* global __PANEL_VERSION__, __PANEL_BUILD__ */
  const stale = !!data && ((data.panelVersion && data.panelVersion !== __PANEL_VERSION__)
    || (__PANEL_BUILD__ && data.buildTime && data.buildTime !== __PANEL_BUILD__))
  const actions = pathname.startsWith('/dashboard')
    ? <Btn variant="accent" onClick={() => setShowNew(true)}><Plus className="h-3.5 w-3.5" /><span className="hidden sm:inline"> Novo projeto</span></Btn>
    : null

  return (
    <Layout data={data} live={live} onLogout={doLogout} onRefresh={refresh} actions={actions} notif={notifPerm} onToggleNotif={toggleNotif} alerts={alerts} onClearAlerts={clearAlerts}>
      {stale && (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-sky-500/10 px-4 py-2.5 text-sm text-sky-100 ring-1 ring-sky-500/30">
          <RefreshCw className="h-4 w-4 text-sky-300" />
          <span>O painel foi atualizado no servidor (v{data.panelVersion}). Esta aba ainda roda a versão anterior.</span>
          <Btn variant="accent" className="ml-auto" onClick={() => window.location.reload()}><RefreshCw className="h-3.5 w-3.5" /> Recarregar agora</Btn>
        </div>
      )}
      {!data ? <DashboardSkeleton /> : (
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard data={data} activity={activity} refresh={refresh} onFlash={setFlash} showNew={showNew} setShowNew={setShowNew} />} />
            <Route path="/report" element={<Report data={data} />} />
            <Route path="/files/*" element={<FilesPage onFlash={setFlash} />} />
            <Route path="/terminal" element={<Navigate to="/terminal/shell" replace />} />
            <Route path="/terminal/:name" element={<TerminalPage data={data} activity={activity} onFlash={setFlash} />} />
            <Route path="/history" element={<HistoryPage data={data} onFlash={setFlash} refresh={refresh} />} />
            <Route path="/history/:name" element={<HistoryPage data={data} onFlash={setFlash} refresh={refresh} />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/backup" element={<BackupPage data={data} onFlash={setFlash} />} />
            <Route path="/settings" element={<SettingsPage data={data} onFlash={setFlash} refresh={refresh} notif={notifPerm} onToggleNotif={toggleNotif} />} />
            <Route path="/notifications" element={<NotificationsPage onFlash={setFlash} />} />
            <Route path="/account" element={<Account data={data} onFlash={setFlash} refresh={refresh} />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      )}
      <Toast flash={flash} onClose={closeFlash} position={isTerm ? 'top-right' : 'bottom'} />
    </Layout>
  )
}
