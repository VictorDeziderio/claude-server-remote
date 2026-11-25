import { useEffect, useRef, useState, useCallback } from 'react'
import * as api from '../api.js'

// Real time via SSE (/api/events): consolidated state, Claude activity per session and
// notifications. If SSE drops, EventSource reconnects by itself; meanwhile a 15s
// polling keeps the state reasonably fresh.
// Tab in the background: closes the EventSource (the server stops working with no clients) and
// reopens it when coming back to the tab — "CPU-light" panel (found by @qa 2026-10-09).
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
          // merge (not replace) with the previous entry: an incremental update that does not bring
          // busySince/remoteUrl must not erase what was there (found by @qa 2026-09-28)
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
    // fallback: polling while SSE is not connected (or the tab is in the
    // background) + when coming back to the tab
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
