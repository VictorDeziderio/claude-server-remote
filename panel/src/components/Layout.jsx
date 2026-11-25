import { useEffect, useRef, useState } from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, BarChart3, FolderTree, SquareTerminal, UserRound, LogOut, RefreshCw, History, ScrollText,
  Settings, DatabaseBackup, PanelLeftClose, PanelLeftOpen, Bell, BellOff, BellRing, HardDrive, MemoryStick, Gauge, Radio, ArrowUpCircle,
  AlertTriangle, Trash2,
} from 'lucide-react'
import Logo from './Logo.jsx'
import { Dot, Btn, Empty } from './ui.jsx'
import { cn } from '../lib/utils.js'
import { fmtAgo } from '../lib/format.js'
import * as api from '../api.js'

// Rotas com URL propria (react-router)
export const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
  { to: '/files', label: 'Arquivos', icon: FolderTree },
  { to: '/history', label: 'Histórico', icon: History },
  { to: '/report', label: 'Relatório', icon: BarChart3 },
  { to: '/backup', label: 'Backup', icon: DatabaseBackup },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/settings', label: 'Configurações', icon: Settings },
  { to: '/notifications', label: 'Notifications', icon: BellRing },
  { to: '/account', label: 'Conta', icon: UserRound },
]
const titleOf = (path) => (NAV.find((n) => path === n.to || path.startsWith(n.to + '/')) || {}).label || 'Claude Remote'
const LS_NAV = 'cr.nav.collapsed'
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }

const pctCls = (p) => (p >= 90 ? 'text-destructive' : p >= 75 ? 'text-primary' : 'text-muted-foreground')
const ALERT_CLS = { error: 'text-destructive', critical: 'text-destructive', warn: 'text-amber-300', warning: 'text-amber-300' }

// Sininho de alertas (saude da VM): lista os ultimos avisos que chegaram pelo SSE
// ('notify' kind:'alert') + os que ja estavam registrados no servidor, com "Limpar".
function AlertsBell({ alerts, onClear }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div ref={boxRef} className="relative">
      <Btn variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} title="alertas">
        <span className="relative inline-flex">
          <AlertTriangle className={cn('size-3.5', alerts.length > 0 && 'text-amber-300')} />
          {alerts.length > 0 && <span className="absolute -right-1.5 -top-1.5 grid size-3.5 place-items-center rounded-full bg-destructive text-[9px] font-medium text-white">{alerts.length > 9 ? '9+' : alerts.length}</span>}
        </span>
      </Btn>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-[min(92vw,22rem)] rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-xs font-medium text-foreground">Alertas</span>
            {alerts.length > 0 && (
              <button type="button" onClick={onClear} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground">
                <Trash2 className="size-3" /> Limpar
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-auto">
            {alerts.length === 0 ? (
              <Empty>sem alertas</Empty>
            ) : (
              <ul className="space-y-1">
                {alerts.map((a, i) => (
                  <li key={i} className="rounded-md px-2 py-1.5 text-xs hover:bg-accent">
                    <div className={cn('font-medium', ALERT_CLS[a.level] || 'text-foreground')}>{a.msg}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">{a.project ? a.project + ' · ' : ''}{fmtAgo(a.t)}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Layout({ data, live, onLogout, onRefresh, actions, notif, onToggleNotif, alerts = [], onClearAlerts, children }) {
  const { pathname } = useLocation()
  const login = data?.login || { logged: false, account: '' }
  const isTerm = pathname.startsWith('/terminal')
  const [collapsed, setCollapsed] = useState(() => readLS(LS_NAV, false))
  const [health, setHealth] = useState(null)
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(LS_NAV, JSON.stringify(!c)) } catch { /* */ } return !c })

  // so consulta /api/health com a aba visivel (achado @qa 2026-10-09: painel "CPU-light")
  const ready = !!data
  useEffect(() => {
    if (!ready) return undefined
    let alive = true
    const load = () => { if (document.visibilityState === 'visible') api.health().then((h) => { if (alive && h.ok) setHealth(h) }).catch(() => {}) }
    load()
    const t = setInterval(load, 60000)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [ready])

  const navCls = ({ isActive }) =>
    cn('flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      collapsed && 'justify-center',
      isActive ? 'bg-sidebar-accent text-sidebar-primary' : 'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground')
  const NotifIcon = notif === 'granted' ? BellRing : notif === 'denied' ? BellOff : Bell

  return (
    <div className="flex h-full">
      {/* Sidebar (desktop) */}
      <aside className={cn('hidden h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar sm:flex', collapsed ? 'w-14 p-2' : 'w-52 p-3')}>
        <NavLink to="/dashboard" className={cn('mb-5 flex items-center gap-2.5 px-1', collapsed && 'justify-center')} title="Claude Remote">
          <div className="grid size-8 shrink-0 place-items-center rounded-md border border-sidebar-border bg-sidebar-accent text-primary"><Logo size={18} /></div>
          {!collapsed && <div className="text-sm font-medium text-sidebar-foreground">claude<span className="text-primary">/</span>remote</div>}
        </NavLink>
        <nav className="space-y-0.5">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={navCls} title={n.label}><n.icon className="size-4 shrink-0" /> {!collapsed && n.label}</NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 pt-4">
          {!collapsed && (
            <NavLink to="/account" className="block rounded-md border border-sidebar-border p-2.5 transition-colors hover:border-primary/40">
              <div className="text-[10px] text-sidebar-foreground/50">conta claude</div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-sidebar-foreground/80"><Dot on={login.logged} /> {login.logged ? (login.account || 'logado') : 'deslogado'}</div>
            </NavLink>
          )}
          <button type="button" onClick={onLogout} title="sair do painel" className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground', collapsed && 'justify-center')}><LogOut className="size-4" /> {!collapsed && 'sair do painel'}</button>
          <button type="button" onClick={toggle} title={collapsed ? 'expandir menu' : 'recolher menu'} className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-sidebar-foreground/40 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground/70', collapsed && 'justify-center')}>
            {collapsed ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-4" /> recolher</>}
          </button>
          {!collapsed && data?.panelVersion && (
            <div className="px-2.5 text-[10px] text-sidebar-foreground/30" title={data.buildTime ? 'build ' + data.buildTime : 'build local'}>
              v{data.panelVersion}{data.buildTime ? ` · ${data.buildTime.slice(0, 10)} ${data.buildTime.slice(11, 16)}` : ''}
            </div>
          )}
        </div>
      </aside>

      {/* Conteudo */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Nav mobile */}
        <div className="flex gap-1.5 overflow-x-auto border-b border-border px-3 py-2 sm:hidden">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to}
              className={({ isActive }) => cn('flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs', isActive ? 'bg-accent text-primary' : 'bg-card text-muted-foreground')}>
              <n.icon className="size-4" /> {n.label}
            </NavLink>
          ))}
        </div>

        <div className={cn('flex items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6', isTerm && 'py-2.5')}>
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-base font-medium text-foreground">{titleOf(pathname)}</h1>
            <span className={cn('hidden items-center gap-1.5 text-xs sm:inline-flex', live ? 'text-success' : 'text-muted-foreground')} title={live ? 'tempo real conectado (SSE)' : 'tempo real desconectado — usando polling'}>
              <Dot color={live ? 'bg-success' : 'bg-muted-foreground/40'} pulse={live} /> {live ? 'ao vivo' : 'polling'}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {health && (
              <Link to={health.claude?.updateAvailable ? '/account' : '/dashboard'} className={cn('hidden items-center gap-3 rounded-md border px-2.5 py-1 text-xs lg:flex', health.claude?.updateAvailable ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground')} title={health.claude?.updateAvailable ? `Claude Code ${health.claude.latest} disponível (instalado ${health.claude.currentNum}) — clique p/ atualizar` : 'saúde do host — clique p/ detalhes'}>
                <span className={cn('inline-flex items-center gap-1', pctCls(health.disk?.pct || 0))}><HardDrive className="size-3" /> {health.disk?.pct ?? '?'}%</span>
                <span className={cn('inline-flex items-center gap-1', pctCls(health.mem?.pct || 0))}><MemoryStick className="size-3" /> {health.mem?.pct ?? '?'}%</span>
                <span className="inline-flex items-center gap-1"><Gauge className="size-3" /> {health.load?.[0] ?? '?'}</span>
                {health.claude?.updateAvailable && <span className="inline-flex items-center gap-1"><ArrowUpCircle className="size-3" /> {health.claude.latest}</span>}
              </Link>
            )}
            {actions}
            <AlertsBell alerts={alerts} onClear={onClearAlerts} />
            <Btn variant="ghost" size="sm" onClick={onToggleNotif} title={notif === 'granted' ? 'notificações do navegador ativas' : notif === 'denied' ? 'notificações bloqueadas no navegador' : 'ativar notificações do navegador'}>
              <NotifIcon className={cn('size-3.5', notif === 'granted' && 'text-success')} />
            </Btn>
            <Btn variant="ghost" size="sm" onClick={onRefresh} title="recarregar estado"><RefreshCw className="size-3.5" /></Btn>
          </div>
        </div>

        <div className={cn('min-h-0 flex-1', isTerm ? 'flex flex-col px-3 pb-3 sm:px-6 sm:pb-5' : 'overflow-auto px-4 pb-6 pt-4 sm:px-6')}>
          {children}
        </div>
      </main>
    </div>
  )
}
