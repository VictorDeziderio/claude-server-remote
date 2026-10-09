import { useEffect, useRef, useState, useCallback } from 'react'
import * as api from '../api.js'

// Tempo real via SSE (/api/events): estado consolidado, atividade do Claude por sessao e
// notificacoes. Se o SSE cair, o EventSource reconecta sozinho; enquanto isso um polling
// de 15s mantem o estado razoavelmente fresco.
// Aba em segundo plano: fecha o EventSource (o servidor para de trabalhar sem clientes) e
// reabre ao voltar pra aba — painel "CPU-light" (achado @qa 2026-10-09).
export default function useEvents({ enabled, onState, onUnauth, onNotify }) {
  const [live, setLive] = useState(false)
  const [activity, setActivity] = useState({})
  const esRef = useRef(null)
  const cb = useRef({ onState, onUnauth, onNotify })
  useEffect(() => { cb.current = { onState, onUnauth, onNotify } }, [onState, onUnauth, onNotify])

  const refresh = useCallback(async () => {
    try {
      const d = await api.getState()
      if (d && d.__unauth) { cb.current.onUnauth?.(); return }
      if (d) cb.current.onState?.(d)
    } catch { /* rede */ }
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    let alive = true

    const open = () => {
      if (esRef.current) return
      const es = new EventSource(api.eventsUrl())
      esRef.current = es
      es.onopen = () => { if (alive) setLive(true) }
      es.onerror = () => { if (alive) setLive(false) } // EventSource reconecta sozinho; 401 -> fecha
      es.addEventListener('state', (e) => { try { cb.current.onState?.(JSON.parse(e.data)) } catch { /* */ } })
      es.addEventListener('activity', (e) => {
        try {
          const d = JSON.parse(e.data)
          // merge (nao substitui) com a entrada anterior: um update incremental que nao traga
          // busySince/remoteUrl nao pode apagar o que ja estava (achado @qa 2026-09-28)
          if (d && d.session) {
            const { session, name, ...fields } = d
            setActivity((a) => ({ ...a, [session]: { ...(a[session] || {}), ...fields } }))
          }
          else if (d && typeof d === 'object') setActivity(d) // snapshot inicial
        } catch { /* */ }
      })
      es.addEventListener('notify', (e) => { try { cb.current.onNotify?.(JSON.parse(e.data)) } catch { /* */ } })
    }
    const close = () => {
      if (!esRef.current) return
      esRef.current.close()
      esRef.current = null
      setLive(false)
    }

    if (document.visibilityState === 'visible') open()
    // fallback: polling enquanto o SSE nao estiver conectado (ou a aba estiver em segundo
    // plano) + ao voltar pra aba
    const t = setInterval(() => { if (document.visibilityState === 'visible' && esRef.current?.readyState !== EventSource.OPEN) refresh() }, 15000)
    const onVis = () => {
      if (document.visibilityState === 'visible') { open(); refresh() }
      else close()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVis); close() }
  }, [enabled, refresh])

  return { live, activity, refresh }
}
