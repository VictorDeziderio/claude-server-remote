import { useEffect, useRef, useState } from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, BarChart3, FolderTree, SquareTerminal, UserRound, LogOut, RefreshCw, History, ScrollText,
  Settings, DatabaseBackup, PanelLeftClose, PanelLeftOpen, Bell, BellOff, BellRing, HardDrive, MemoryStick, Gauge, Radio, ArrowUpCircle,
  AlertTriangle, Trash2, Ellipsis, X, Sun, Moon, Monitor,
} from 'lucide-react'
import { readTheme, saveTheme, nextTheme } from '../lib/theme.js'
import Logo from './Logo.jsx'
import { Dot, Btn, Empty } from './ui.jsx'
import { cn } from '../lib/utils.js'
import { fmtAgo } from '../lib/format.js'
import * as api from '../api.js'

// Rotas com URL propria (react-router)
export const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Workspace' },
  { to: '/terminal', label: 'Terminal', icon: SquareTerminal, group: 'Workspace' },
  { to: '/files', label: 'Arquivos', icon: FolderTree, group: 'Workspace' },
  { to: '/history', label: 'Histórico', icon: History, group: 'Workspace' },
  { to: '/report', label: 'Relatório', icon: BarChart3, group: 'Insights' },
  { to: '/logs', label: 'Logs', icon: ScrollText, group: 'Insights' },
  { to: '/backup', label: 'Backup', icon: DatabaseBackup, group: 'System' },
  { to: '/settings', label: 'Configurações', icon: Settings, group: 'System' },
  { to: '/notifications', label: 'Notifications', icon: BellRing, group: 'System' },
  { to: '/account', label: 'Conta', icon: UserRound, group: 'System' },
]
const NAV_GROUPS = [...new Set(NAV.map((n) => n.group))]
// Celular: navegacao EMBAIXO (alcance do polegar) com as 3 telas mais usadas + "More" (folha
// com o resto do NAV — abas novas adicionadas ao NAV aparecem la sozinhas).
const MOBILE_PRIMARY = ['/dashboard', '/terminal', '/files']
const isActivePath = (path, to) => path === to || path.startsWith(to + '/')
function MobileNav({ onLogout }) {
  const { pathname } = useLocation()
  const [more, setMore] = useState(false)
  useEffect(() => { setMore(false) }, [pathname])
  const primary = NAV.filter((n) => MOBILE_PRIMARY.includes(n.to))
  const rest = NAV.filter((n) => !MOBILE_PRIMARY.includes(n.to))
  const restActive = rest.some((n) => isActivePath(pathname, n.to))
  const item = (active) => cn('flex h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors', active ? 'text-primary' : 'text-muted-foreground active:text-foreground')
  return (
    <>
      {more && (
        <div className="fixed inset-0 z-40 bg-black/50 sm:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-0 bottom-0 animate-fade-up rounded-t-xl border-t border-border bg-popover p-3 pb-[calc(env(safe-area-inset-bottom)+4.5rem)]" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="More">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-sm font-medium text-foreground">More</span>
              <button type="button" onClick={() => setMore(false)} aria-label="close" className="grid size-10 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><X className="size-5" /></button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {rest.map((n) => (
                <NavLink key={n.to} to={n.to} className={({ isActive }) => cn('flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border text-xs', isActive ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-foreground/80')}>
                  <n.icon className="size-5" /> {n.label}
                </NavLink>
              ))}
              <button type="button" onClick={onLogout} className="flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-card text-xs text-muted-foreground">
                <LogOut className="size-5" /> sair do painel
              </button>
            </div>
          </div>
        </div>
      )}
      <nav className="hide-on-kb relative z-50 grid shrink-0 grid-cols-4 border-t border-border bg-sidebar sm:hidden" aria-label="main">
        {primary.map((n) => (
          <NavLink key={n.to} to={n.to} className={() => item(isActivePath(pathname, n.to) && !more)}>
            <n.icon className="size-5" /> {n.label}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore((m) => !m)} className={item(more || restActive)} aria-expanded={more}>
          <Ellipsis className="size-5" /> More
        </button>
      </nav>
    </>
  )
}

const titleOf = (path) => (NAV.find((n) => path === n.to || path.startsWith(n.to + '/')) || {}).label || 'Claude Remote'
const LS_NAV = 'cr.nav.collapsed'
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }

const pctCls = (p) => (p >= 90 ? 'text-destructive' : p >= 75 ? 'text-warning' : 'text-muted-foreground')
const ALERT_CLS = { error: 'text-destructive', critical: 'text-destructive', warn: 'text-amber-600 dark:text-amber-300', warning: 'text-amber-600 dark:text-amber-300' }

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon }
const THEME_LABEL = { system: 'tema: sistema', light: 'tema: claro', dark: 'tema: escuro' }
function ThemeToggle() {
  const [pref, setPref] = useState(readTheme)
  const Icon = THEME_ICON[pref] || Monitor
  return (
    <Btn variant="ghost" size="sm" onClick={() => setPref(saveTheme(nextTheme(pref)))} title={THEME_LABEL[pref] + ' (clique p/ trocar)'}>
      <Icon className="size-3.5" />
    </Btn>
  )
}

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
          <AlertTriangle className={cn('size-3.5', alerts.length > 0 && 'text-amber-600 dark:text-amber-300')} />
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
      isActive ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground')
  const NotifIcon = notif === 'granted' ? BellRing : notif === 'denied' ? BellOff : Bell

  return (
    <div className="flex h-full">
      {/* Sidebar (desktop) */}
      <aside className={cn('hidden h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar sm:flex', collapsed ? 'w-14 p-2' : 'w-60 p-3')}>
        <NavLink to="/dashboard" className={cn('mb-5 flex items-center gap-2.5 px-1', collapsed && 'justify-center')} title="Claude Remote">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-brand shadow-sm"><Logo size={18} /></div>
          {!collapsed && (
            <div className="leading-tight">
              <div className="text-sm font-semibold text-sidebar-accent-foreground">claude<span className="text-brand">/</span>remote</div>
              <div className="text-[11px] text-sidebar-foreground/60">dev-box panel</div>
            </div>
          )}
        </NavLink>
        <nav className="space-y-4">
          {NAV_GROUPS.map((g) => (
            <div key={g} className="space-y-0.5">
              {!collapsed && <div className="px-2.5 pb-1 text-[11px] font-medium text-sidebar-foreground/50">{g}</div>}
              {NAV.filter((n) => n.group === g).map((n) => (
                <NavLink key={n.to} to={n.to} className={navCls} title={n.label}><n.icon className="size-4 shrink-0" /> {!collapsed && n.label}</NavLink>
              ))}
            </div>
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
        {/* celular: no Terminal o cabecalho some (cada linha vale ouro; a aba fica na nav de baixo) */}
        <div className={cn('flex items-center justify-between gap-2 border-b border-border bg-background/80 px-4 py-2 backdrop-blur sm:px-6 sm:py-3', isTerm && 'hidden sm:flex sm:py-2.5')}>
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground">{titleOf(pathname)}</h1>
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
            <ThemeToggle />
            <AlertsBell alerts={alerts} onClear={onClearAlerts} />
            <Btn variant="ghost" size="sm" onClick={onToggleNotif} title={notif === 'granted' ? 'notificações do navegador ativas' : notif === 'denied' ? 'notificações bloqueadas no navegador' : 'ativar notificações do navegador'}>
              <NotifIcon className={cn('size-3.5', notif === 'granted' && 'text-success')} />
            </Btn>
            <Btn variant="ghost" size="sm" onClick={onRefresh} title="recarregar estado"><RefreshCw className="size-3.5" /></Btn>
          </div>
        </div>

        <div className={cn('min-h-0 flex-1', isTerm ? 'flex flex-col sm:px-6 sm:pb-5' : 'overflow-auto px-3 pb-6 pt-3 sm:px-6 sm:pt-4')}>
          {children}
        </div>
        <MobileNav onLogout={onLogout} />
      </main>
    </div>
  )
}
