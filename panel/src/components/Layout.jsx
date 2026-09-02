import { useEffect, useState } from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, BarChart3, FolderTree, SquareTerminal, UserRound, LogOut, RefreshCw, History, ScrollText,
  Settings, DatabaseBackup, PanelLeftClose, PanelLeftOpen, Bell, BellOff, BellRing, HardDrive, MemoryStick, Gauge, Radio, ArrowUpCircle,
} from 'lucide-react'
import Logo from './Logo.jsx'
import { Dot, Btn } from './ui.jsx'
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
  { to: '/account', label: 'Conta', icon: UserRound },
]
const titleOf = (path) => (NAV.find((n) => path === n.to || path.startsWith(n.to + '/')) || {}).label || 'Claude Remote'
const LS_NAV = 'cr.nav.collapsed'
const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } }

const pctCls = (p) => (p >= 90 ? 'text-rose-300' : p >= 75 ? 'text-amber-300' : 'text-slate-300')

export default function Layout({ data, live, onLogout, onRefresh, actions, notif, onToggleNotif, children }) {
  const { pathname } = useLocation()
  const login = data?.login || { logged: false, account: '' }
  const isTerm = pathname.startsWith('/terminal')
  const [collapsed, setCollapsed] = useState(() => readLS(LS_NAV, false))
  const [health, setHealth] = useState(null)
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(LS_NAV, JSON.stringify(!c)) } catch { /* */ } return !c })

  const ready = !!data
  useEffect(() => {
    if (!ready) return undefined
    let alive = true
    const load = () => api.health().then((h) => { if (alive && h.ok) setHealth(h) }).catch(() => {})
    load()
    const t = setInterval(load, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [ready])

  const navCls = ({ isActive }) =>
    `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-claude/60 ${collapsed ? 'justify-center' : ''} ${
      isActive ? 'bg-claude/15 text-claude ring-1 ring-claude/25' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`
  const NotifIcon = notif === 'granted' ? BellRing : notif === 'denied' ? BellOff : Bell

  return (
    <div className="flex h-full">
      {/* Sidebar (desktop) */}
      <aside className={`hidden h-full shrink-0 flex-col border-r border-white/5 bg-ink-900/40 sm:flex ${collapsed ? 'w-16 p-2' : 'w-56 p-4'}`}>
        <NavLink to="/dashboard" className={`mb-6 flex items-center gap-2.5 ${collapsed ? 'justify-center' : ''}`} title="Claude Remote">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ink-700 ring-1 ring-claude/30"><Logo size={22} /></div>
          {!collapsed && <div className="text-sm font-semibold text-white">Claude <span className="text-claude">Remote</span></div>}
        </NavLink>
        <nav className="space-y-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={navCls} title={n.label}><n.icon className="h-4 w-4 shrink-0" /> {!collapsed && n.label}</NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 pt-4">
          {!collapsed && (
            <NavLink to="/account" className="block rounded-xl bg-ink-800 p-3 ring-1 ring-white/5 transition hover:ring-claude/30">
              <div className="text-[11px] uppercase tracking-wide text-slate-500">conta Claude</div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-300"><Dot on={login.logged} /> {login.logged ? (login.account || 'logado') : 'deslogado'}</div>
            </NavLink>
          )}
          <button type="button" onClick={onLogout} title="sair do painel" className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/5 hover:text-slate-200 ${collapsed ? 'justify-center' : ''}`}><LogOut className="h-4 w-4" /> {!collapsed && 'sair do painel'}</button>
          <button type="button" onClick={toggle} title={collapsed ? 'expandir menu' : 'recolher menu'} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-500 transition hover:bg-white/5 hover:text-slate-300 ${collapsed ? 'justify-center' : ''}`}>
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <><PanelLeftClose className="h-4 w-4" /> recolher</>}
          </button>
          {!collapsed && data?.panelVersion && (
            <div className="px-3 text-[10px] text-slate-600" title={data.buildTime ? 'build ' + data.buildTime : 'build local'}>
              painel v{data.panelVersion}{data.buildTime ? ` · ${data.buildTime.slice(0, 10)} ${data.buildTime.slice(11, 16)}` : ''}
            </div>
          )}
        </div>
      </aside>

      {/* Conteudo */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Nav mobile */}
        <div className="flex gap-2 overflow-x-auto border-b border-white/5 px-3 py-2 sm:hidden">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to}
              className={({ isActive }) => `flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium ${isActive ? 'bg-claude/15 text-claude ring-1 ring-claude/25' : 'bg-ink-800 text-slate-400'}`}>
              <n.icon className="h-4 w-4" /> {n.label}
            </NavLink>
          ))}
        </div>

        <div className={`flex items-center justify-between gap-2 px-4 pt-4 sm:px-6 ${isTerm ? 'pb-3' : 'pb-4'}`}>
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-lg font-semibold text-white">{titleOf(pathname)}</h1>
            <span className={`hidden items-center gap-1 text-[11px] sm:inline-flex ${live ? 'text-emerald-400' : 'text-slate-500'}`} title={live ? 'tempo real conectado (SSE)' : 'tempo real desconectado — usando polling'}>
              <Radio className="h-3 w-3" /> {live ? 'ao vivo' : 'polling'}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {health && (
              <Link to={health.claude?.updateAvailable ? '/account' : '/dashboard'} className={`hidden items-center gap-3 rounded-lg bg-ink-800 px-2.5 py-1.5 text-[11px] ring-1 lg:flex ${health.claude?.updateAvailable ? 'ring-amber-500/40' : 'ring-white/5'}`} title={health.claude?.updateAvailable ? `Claude Code ${health.claude.latest} disponível (instalado ${health.claude.currentNum}) — clique p/ atualizar` : 'saúde do host — clique p/ detalhes'}>
                <span className={`inline-flex items-center gap-1 ${pctCls(health.disk?.pct || 0)}`}><HardDrive className="h-3 w-3" /> {health.disk?.pct ?? '?'}%</span>
                <span className={`inline-flex items-center gap-1 ${pctCls(health.mem?.pct || 0)}`}><MemoryStick className="h-3 w-3" /> {health.mem?.pct ?? '?'}%</span>
                <span className="inline-flex items-center gap-1 text-slate-300"><Gauge className="h-3 w-3" /> {health.load?.[0] ?? '?'}</span>
                {health.claude?.updateAvailable && <span className="inline-flex items-center gap-1 text-amber-300"><ArrowUpCircle className="h-3 w-3" /> Claude {health.claude.latest}</span>}
              </Link>
            )}
            {actions}
            <Btn variant="ghost" onClick={onToggleNotif} title={notif === 'granted' ? 'notificações do navegador ativas' : notif === 'denied' ? 'notificações bloqueadas no navegador' : 'ativar notificações do navegador'}>
              <NotifIcon className={`h-3.5 w-3.5 ${notif === 'granted' ? 'text-emerald-300' : ''}`} />
            </Btn>
            <Btn variant="ghost" onClick={onRefresh} title="recarregar estado"><RefreshCw className="h-3.5 w-3.5" /></Btn>
          </div>
        </div>

        <div className={`min-h-0 flex-1 ${isTerm ? 'flex flex-col px-3 pb-3 sm:px-6 sm:pb-5' : 'overflow-auto px-4 pb-6 sm:px-6'}`}>
          {children}
        </div>
      </main>
    </div>
  )
}
