import { useEffect, useState, useCallback } from 'react'
import {
  Folder, FileText, RefreshCw, Save, X, Trash2, FilePlus, FolderPlus,
  Home, Loader2, ChevronRight, Pencil,
} from 'lucide-react'
import * as api from '../api.js'

const fmtSize = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(1) + ' kB' : (n || 0) + ' B')
const join = (a, b) => (a ? a.replace(/\/+$/, '') + '/' + b : b)
const parentOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

// IDE simples: navegar /root e cada projeto, ver e (opcional) editar arquivos.
export default function Files({ initialPath = '', onFlash }) {
  const [cwd, setCwd] = useState(initialPath)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(null) // { path }
  const [draft, setDraft] = useState('')
  const [orig, setOrig] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async (p) => {
    setLoading(true)
    const r = await api.fsList(p)
    setLoading(false)
    if (r.ok) { setCwd(r.path); setEntries(r.entries) }
    else onFlash?.({ ok: false, msg: r.msg })
  }, [onFlash])

  useEffect(() => { load(initialPath) }, [load, initialPath])

  const enter = (e) => { if (e.type === 'dir') load(join(cwd, e.name)); else openFile(e.name) }
  const openFile = async (name) => {
    const r = await api.fsRead(join(cwd, name))
    if (r.ok) { setOpen({ path: r.path }); setDraft(r.content); setOrig(r.content) }
    else onFlash?.({ ok: false, msg: r.msg })
  }
  const save = async () => {
    setBusy('save')
    const r = await api.fsSave(open.path, draft)
    setBusy('')
    onFlash?.(r)
    if (r.ok) setOrig(draft)
  }
  const newItem = async (kind) => {
    const name = window.prompt(kind === 'dir' ? 'Nome da nova pasta:' : 'Nome do novo arquivo:')
    if (!name) return
    const r = await api.fsCreate(join(cwd, name), kind)
    onFlash?.(r); if (r.ok) load(cwd)
  }
  const del = async (e) => {
    if (!window.confirm(`Excluir "${e.name}"${e.type === 'dir' ? ' e todo o conteúdo' : ''}? Isso é permanente.`)) return
    const r = await api.fsDelete(join(cwd, e.name))
    onFlash?.(r); if (r.ok) load(cwd)
  }
  const rename = async (e) => {
    const name = window.prompt('Novo nome:', e.name)
    if (!name || name === e.name) return
    const r = await api.fsRename(join(cwd, e.name), join(cwd, name))
    onFlash?.(r); if (r.ok) load(cwd)
  }

  const parts = cwd ? cwd.split('/') : []
  const dirty = open && draft !== orig

  if (open) {
    return (
      <div className="rounded-2xl bg-ink-800 ring-1 ring-white/5">
        <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <FileText className="h-4 w-4 shrink-0 text-claude" />
            <code className="truncate text-slate-200">/root/{open.path}</code>
            {dirty && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">não salvo</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={save} disabled={busy === 'save' || !dirty}
              className="inline-flex items-center gap-1.5 rounded-lg bg-claude/90 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-claude disabled:opacity-40">
              {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Salvar
            </button>
            <button onClick={() => setOpen(null)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink-500 px-3 py-1.5 text-[13px] font-medium text-slate-100 transition hover:bg-ink-500/70">
              <X className="h-3.5 w-3.5" /> Fechar
            </button>
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-[60vh] w-full resize-none rounded-b-2xl bg-ink-900 p-4 font-mono text-[13px] leading-relaxed text-slate-200 focus:outline-none"
        />
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-ink-800 ring-1 ring-white/5">
      {/* Toolbar + breadcrumb */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-slate-300">
          <button onClick={() => load('')} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/5" title="raiz">
            <Home className="h-3.5 w-3.5 text-claude" /> root
          </button>
          {parts.map((seg, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
              <button onClick={() => load(parts.slice(0, i + 1).join('/'))} className="rounded px-1.5 py-0.5 hover:bg-white/5">{seg}</button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <IconBtn onClick={() => newItem('file')} title="novo arquivo"><FilePlus className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => newItem('dir')} title="nova pasta"><FolderPlus className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => load(cwd)} title="atualizar">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </IconBtn>
        </div>
      </div>

      {/* Lista */}
      <div className="max-h-[62vh] overflow-auto p-2">
        {cwd !== '' && (
          <Row onClick={() => load(parentOf(cwd))} icon={<Folder className="h-4 w-4 text-slate-400" />} name=".." muted />
        )}
        {entries.length === 0 && !loading && (
          <div className="px-3 py-6 text-center text-sm text-slate-500">pasta vazia</div>
        )}
        {entries.map((e) => (
          <Row
            key={e.name}
            onClick={() => enter(e)}
            icon={e.type === 'dir'
              ? <Folder className="h-4 w-4 text-claude" />
              : <FileText className="h-4 w-4 text-slate-400" />}
            name={e.name}
            right={e.type === 'file' ? <span className="text-[11px] text-slate-500">{fmtSize(e.size)}</span> : null}
            actions={
              <>
                <button onClick={(ev) => { ev.stopPropagation(); rename(e) }} title="renomear" className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={(ev) => { ev.stopPropagation(); del(e) }} title="excluir" className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
              </>
            }
          />
        ))}
      </div>
    </div>
  )
}

function IconBtn({ onClick, title, children }) {
  return (
    <button onClick={onClick} title={title}
      className="rounded-lg bg-ink-700/60 p-2 text-slate-300 ring-1 ring-white/5 transition hover:bg-ink-500 hover:text-white">
      {children}
    </button>
  )
}

function Row({ onClick, icon, name, right, actions, muted }) {
  return (
    <div
      onClick={onClick}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition hover:bg-white/5 ${muted ? 'text-slate-500' : 'text-slate-200'}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {right}
      {actions && <span className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">{actions}</span>}
    </div>
  )
}
