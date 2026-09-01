import { useEffect, useState, useCallback } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Loader2, Plus } from 'lucide-react'
import Layout from './components/Layout.jsx'
import Login from './components/Login.jsx'
import { Btn, Toast } from './components/ui.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Report from './pages/Report.jsx'
import Files from './pages/Files.jsx'
import TerminalPage from './pages/TerminalPage.jsx'
import Account from './pages/Account.jsx'
import * as api from './api.js'

export default function App() {
  const [data, setData] = useState(null)
  const [authed, setAuthed] = useState(null) // null = ainda nao sabemos
  const [flash, setFlash] = useState(null)
  const [showNew, setShowNew] = useState(false)
  const { pathname } = useLocation()

  const refresh = useCallback(async () => {
    try {
      const d = await api.getState()
      if (d && d.__unauth) { setAuthed(false); return }
      setAuthed(true)
      setData(d)
    } catch (e) {
      setFlash({ ok: false, msg: 'falha ao carregar estado: ' + e.message })
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 15000)
    const onVis = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [refresh])

  const doLogout = async () => { try { await api.logout() } catch { /* */ } setData(null); setAuthed(false) }
  const closeFlash = useCallback(() => setFlash(null), [])

  if (authed === false) return <Login onSuccess={() => { setAuthed(true); refresh() }} />
  if (!data) {
    return <div className="flex h-full items-center justify-center text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin text-claude" /> carregando…</div>
  }

  const actions = pathname.startsWith('/dashboard')
    ? <Btn variant="accent" onClick={() => setShowNew(true)}><Plus className="h-3.5 w-3.5" /> Novo projeto</Btn>
    : null

  return (
    <Layout data={data} onLogout={doLogout} onRefresh={refresh} actions={actions}>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard data={data} refresh={refresh} onFlash={setFlash} showNew={showNew} setShowNew={setShowNew} />} />
        <Route path="/report" element={<Report data={data} />} />
        <Route path="/files/*" element={<Files onFlash={setFlash} />} />
        <Route path="/terminal" element={<Navigate to="/terminal/shell" replace />} />
        <Route path="/terminal/:name" element={<TerminalPage data={data} />} />
        <Route path="/account" element={<Account data={data} onFlash={setFlash} refresh={refresh} />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <Toast flash={flash} onClose={closeFlash} />
    </Layout>
  )
}
