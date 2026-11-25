import { useEffect, useState } from 'react'
import * as api from '../api.js'

// Host health (/api/health), shared by every component that shows it (header pill, dashboard card):
// ONE poll every 60s while at least one of them is mounted, and only with the tab visible
// (found by @qa 2026-10-09: "CPU-light" panel). refresh() reloads now (e.g. after an update).
let last = null
const subs = new Set()
let timer = null
const load = () => api.health().then((h) => { if (h && h.ok) { last = h; subs.forEach((f) => f(h)) } }).catch(() => {})
const tick = () => { if (document.visibilityState === 'visible') load() }
function start() {
  load()
  timer = setInterval(tick, 60000)
  document.addEventListener('visibilitychange', tick)
}
function stop() {
  clearInterval(timer); timer = null
  document.removeEventListener('visibilitychange', tick)
}

export function useHealth(enabled = true) {
  const [h, setH] = useState(last)
  useEffect(() => {
    if (!enabled) return undefined
    subs.add(setH)
    if (subs.size === 1) start()
    else if (last) setH(last)
    return () => { subs.delete(setH); if (!subs.size) stop() }
  }, [enabled])
  return [h, load]
}
