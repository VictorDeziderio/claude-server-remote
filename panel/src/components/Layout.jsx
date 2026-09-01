import { NavLink, useLocation } from 'react-router-dom'
import { LayoutDashboard, BarChart3, FolderTree, SquareTerminal, UserRound, LogOut, RefreshCw } from 'lucide-react'
import Logo from './Logo.jsx'
import { Dot, Btn } from './ui.jsx'

// Rotas com URL propria (react-router): /dashboard, /report, /files/<caminho>, /terminal/<sessao>, /account
export const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/report', label: 'Relatório', icon: BarChart3 },
  { to: '/files', label: 'Arquivos', icon: FolderTree },
  { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
  { to: '/account', label: 'Conta', icon: UserRound },
]

const titleOf = (path) => (NAV.find((n) => path === n.to || path.startsWith(n.to + '/')) || {}).label || 'Claude Remote'

export default function Layout({ data, onLogout, onRefresh, actions, children }) {
  const { pathname } = useLocation()
  const login = data?.login || { logged: false, account: '' }
  const isTerm = pathname.startsWith('/terminal')
  const navCls = ({ isActive }) =>
    `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
      isActive ? 'bg-claude/15 text-claude ring-1 ring-claude/25' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`

  return (
    <div className="flex h-full">
      {/* Sidebar (desktop) */}
      <aside className="hidden h-full w-56 shrink-0 flex-col border-r border-white/5 bg-ink-900/40 p-4 sm:flex">
        <NavLink to="/dashboard" className="mb-6 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-ink-700 ring-1 ring-claude/30"><Logo size={22} /></div>
          <div className="text-sm font-semibold text-white">Claude <span className="text-claude">Remote</span></div>
        </NavLink>
        <nav className="space-y-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={navCls}><n.icon className="h-4 w-4" /> {n.label}</NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 pt-4">
          <NavLink to="/account" className="block rounded-xl bg-ink-800 p-3 ring-1 ring-white/5 transition hover:ring-claude/30">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">conta Claude</div>
            <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-300"><Dot on={login.logged} /> {login.logged ? (login.account || 'logado') : 'deslogado'}</div>
          </NavLink>
          <button type="button" onClick={onLogout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/5 hover:text-slate-200"><LogOut className="h-4 w-4" /> sair do painel</button>
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
          <h1 className="truncate text-lg font-semibold text-white">{titleOf(pathname)}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <Btn variant="ghost" onClick={onRefresh} title="recarregar estado"><RefreshCw className="h-3.5 w-3.5" /><span className="hidden sm:inline"> atualizar</span></Btn>
          </div>
        </div>

        <div className={`min-h-0 flex-1 ${isTerm ? 'flex flex-col px-3 pb-3 sm:px-6 sm:pb-5' : 'overflow-auto px-4 pb-6 sm:px-6'}`}>
          {children}
        </div>
      </main>
    </div>
  )
}
