import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Search, SquareTerminal, FolderOpen, Plus, SunMoon, LogOut, CornerDownLeft } from 'lucide-react'
import { readTheme, saveTheme, nextTheme } from '../lib/theme.js'
import { cn } from '../lib/utils.js'
import { t } from '../lib/i18n.js'

// Command palette (Ctrl+K / Cmd+K, or the search button in the header): jump to any page, open a
// project's terminal or files, or run a panel action, from the keyboard. Same overlay layer as the
// modals (z-[80], Radix Dialog: focus trap, Escape, focus returned to the opener).
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function useCommandMenuHotkey(setOpen) {
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        // inside the terminal Ctrl+K belongs to the shell (kill to end of line): only Cmd+K there
        if (e.ctrlKey && document.activeElement?.closest('.xterm')) return
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])
}

export default function CommandMenu({ open, setOpen, nav = [], projects = [], onNewProject, onLogout }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef(null)
  useEffect(() => { if (open) { setQ(''); setSel(0) } }, [open])

  const groups = useMemo(() => {
    const go = (to) => () => navigate(to)
    const all = [
      { id: 'pages', label: t('cmd.pages'), items: nav.map((n) => ({ key: n.to, icon: n.icon, label: n.label, run: go(n.to) })) },
      {
        id: 'projects', label: t('cmd.projects'), items: projects.flatMap((p) => [
          { key: 't:' + p.name, icon: SquareTerminal, label: t('cmd.terminalOf', { name: p.name }), run: go('/terminal/' + encodeURIComponent(p.name)) },
          { key: 'f:' + p.name, icon: FolderOpen, label: t('cmd.filesOf', { name: p.name }), run: go('/files/projects/' + encodeURIComponent(p.name)) },
        ]),
      },
      {
        id: 'actions', label: t('cmd.actions'), items: [
          { key: 'new', icon: Plus, label: t('projects.new'), run: () => { navigate('/dashboard'); onNewProject?.() } },
          { key: 'theme', icon: SunMoon, label: t('cmd.theme'), run: () => saveTheme(nextTheme(readTheme())) },
          { key: 'logout', icon: LogOut, label: t('nav.logout'), run: () => onLogout?.() },
        ],
      },
    ]
    const nq = norm(q.trim())
    return all.map((g) => ({ ...g, items: nq ? g.items.filter((i) => norm(i.label).includes(nq)) : g.items })).filter((g) => g.items.length)
  }, [q, nav, projects, navigate, onNewProject, onLogout])
  const flat = groups.flatMap((g) => g.items)
  useEffect(() => { setSel(0) }, [q])
  useEffect(() => { listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [sel])

  const runItem = (item) => { setOpen(false); setTimeout(item.run, 0) }
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (flat.length ? (s + 1) % flat.length : 0)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (flat.length ? (s - 1 + flat.length) % flat.length : 0)) }
    else if (e.key === 'Enter' && flat[sel]) { e.preventDefault(); runItem(flat[sel]) }
  }

  let idx = -1
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] animate-fade-in bg-black/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content data-slot="command-menu" aria-describedby={undefined}
          className="fixed inset-x-0 top-[12vh] z-[80] mx-auto w-[min(94vw,36rem)] animate-fade-in overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none">
          <DialogPrimitive.Title className="sr-only">{t('cmd.search')}</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder={t('cmd.placeholder')}
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" aria-label={t('cmd.search')} />
            <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">Esc</kbd>
          </div>
          <div ref={listRef} className="max-h-[min(60vh,24rem)] overflow-y-auto p-1.5" role="listbox">
            {flat.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">{t('cmd.empty')}</div>}
            {groups.map((g) => (
              <div key={g.id} className="pb-1">
                <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">{g.label}</div>
                {g.items.map((item) => {
                  idx += 1
                  const i = idx
                  return (
                    <button key={item.key} type="button" role="option" aria-selected={i === sel} data-selected={i === sel}
                      onMouseMove={() => setSel(i)} onClick={() => runItem(item)}
                      className={cn('flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm', i === sel ? 'bg-accent text-accent-foreground' : 'text-foreground/90')}>
                      <item.icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {i === sel && <CornerDownLeft className="size-3.5 text-muted-foreground" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="hidden items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground sm:flex">{t('cmd.hint')}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
