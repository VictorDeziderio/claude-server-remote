import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react'
import { Folder, FileText, RefreshCw, Save, Trash2, FilePlus, FolderPlus, Home, Loader2, ChevronRight, Pencil, ArrowLeft, Download, Upload, FileCode2, FileImage, FileArchive } from 'lucide-react'
import { Btn, IconBtn, Empty, InlineConfirm, InlineInput, Skeleton } from './ui.jsx'
import { fmtSize, fmtDate, joinPath, parentOf } from '../lib/format.js'
import * as api from '../api.js'

const CodeEditor = lazy(() => import('./CodeEditor.jsx'))

const iconFor = (name) => {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return FileImage
  if (['zip', 'tar', 'gz', 'tgz', 'xz', '7z', 'rar'].includes(ext)) return FileArchive
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'sh', 'json', 'yml', 'yaml', 'toml', 'css', 'html', 'sql', 'go', 'rs', 'java'].includes(ext)) return FileCode2
  return FileText
}

// Gerenciador de arquivos. `path'+ `onNavigate` vem de fora (URL na pagina, estado local quando
// embutido no terminal). Pasta -> lista; arquivo -> editor (CodeMirror, carregado sob demanda).
export default function Files({ path: cur = '', onNavigate, onFlash, embedded = false }) {
  const go = useCallback((p) => onNavigate(p.replace(/^\/+|\/+$/g, '')), [onNavigate])
  const [kind, setKind] = useState('') // '' | dir | file
  const [entries, setEntries] = useState([])
  const [file, setFile] = useState(null) // { path, size, mtime }
  const [draft, setDraft] = useState('')
  const [orig, setOrig] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [creating, setCreating] = useState('') // 'file' | 'dir' | ''
  const [renaming, setRenaming] = useState('') // nome da entrada
  const [deleting, setDeleting] = useState('') // nome da entrada
  const uploadRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const st = await api.fsStat(cur)
      if (!st.ok) {
        onFlash?.({ ok: false, msg: `${cur || '/'}: ${st.msg}` })
        if (cur) go(parentOf(cur))
        return
      }
      if (st.type === 'dir') {
        const r = await api.fsList(cur)
        if (!r.ok) {
          onFlash?.({ ok: false, msg: r.msg })
          return
        }
        setKind('dir')
        setEntries(r.entries)
        setFile(null)
      } else {
        const r = await api.fsRead(cur)
        if (!r.ok) {
          onFlash?.({ ok: false, msg: r.msg })
          if (r.code === 'BINARY' || r.code === 'TOOBIG') window.open(api.fsDownloadUrl(cur), '_blank')
          go(parentOf(cur))
          return
        }
        setKind('file')
        setFile({ path: r.path, size: r.size, mtime: r.mtime })
        setDraft(r.content)
        setOrig(r.content)
      }
    } catch (e) {
      onFlash?.({ ok: false, msg: e.message })
    } finally {
      setLoading(false)
      setCreating('')
      setRenaming('')
      setDeleting('')
    }
  }, [cur, go, onFlash])
  useEffect(() => {
    load()
  }, [load])

  const dirty = kind === 'file' && draft !== orig
  const save = useCallback(async () => {
    if (!dirty) return
    setBusy('save')
    const r = await api.fsSave(file.path, draft)
    setBusy('')
    onFlash?.(r)
    if (r.ok) setOrig(draft)
  }, [dirty, file, draft, onFlash])
  useEffect(() => {
    if (embedded) return undefined
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && kind === 'file') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [kind, save, embedded])
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const createItem = async (name) => {
    setBusy('create')
    const r = await api.fsCreate(joinPath(cur, name), creating)
    setBusy('')
    onFlash?.(r)
    if (r.ok) creating === 'dir' ? load() : go(r.path)
    else setCreating('')
  }
  const delItem = async (e) => {
    setBusy('del:' + e.name)
    const r = await api.fsDelete(joinPath(cur, e.name))
    setBusy('')
    onFlash?.(r)
    load()
  }
  const renameItem = async (e, name) => {
    if (name === e.name) return setRenaming('')
    setBusy('ren:' + e.name)
    const r = await api.fsRename(joinPath(cur, e.name), joinPath(cur, name))
    setBusy('')
    onFlash?.(r)
    load()
  }
  const upload = async (files) => {
    if (!files || !files.length) return
    setBusy('upload')
    let okN = 0
    for (const f of files) {
      const target = joinPath(cur, f.name)
      let r = await api.fsUpload(target, f, false)
      if (!r.ok && /ja existe/.test(r.msg) && window.confirm(`"${f.name}" já existe. Sobrescrever?`)) r = await api.fsUpload(target, f, true)
      if (r.ok) okN++
      else onFlash?.(r)
    }
    setBusy('')
    if (okN) onFlash?.({ ok: true, msg: `${okN} arquivo(s) enviado(s) para /root/${cur || ''}` })
    load()
  }
  const onDrop = (e) => {
    e.preventDefault()
    if (kind === 'dir') upload(e.dataTransfer?.files)
  }

  const parts = cur ? cur.split('/') : []
  const Crumbs = () => (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
      <button type="button" onClick={() => go('')} title="/root" className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-accent ${parts.length === 0 ? 'text-slate-200 font-medium' : 'text-slate-500 hover:text-slate-300'}`}>
        <Home className="h-3.5 w-3.5 text-primary" /> {!embedded && 'root'}
      </button>
      {parts.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-700" />
          {i === parts.length - 1 ? (
            <span className="max-w-[12rem] truncate px-1.5 py-0.5 font-medium text-slate-200">{seg}</span>
          ) : (
            <button type="button" onClick={() => go(parts.slice(0, i + 1).join('/'))} className="max-w-[10rem] truncate rounded px-1.5 py-0.5 text-slate-500 transition hover:bg-accent hover:text-slate-300">
              {seg}
            </button>
          )}
        </span>
      ))}
    </div>
  )

  if (kind === 'file' && file) {
    return (
      <div className={`flex h-full min-h-0 flex-col rounded-lg bg-card border ${embedded ? '' : 'min-h-[60vh]'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/6 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Btn size="sm" onClick={() => go(parentOf(cur))}>
              <ArrowLeft className="h-3.5 w-3.5" /> {!embedded && 'Voltar'}
            </Btn>
            <Crumbs />
            {dirty && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-xs text-amber-300">não salvo</span>}
            {!embedded && (
              <span className="font-mono text-xs text-slate-500">
                {fmtSize(file.size)} · {fmtDate(file.mtime)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <a href={api.fsDownloadUrl(file.path)} title="baixar" className="rounded-lg bg-accent p-2 text-slate-300 border transition duration-150 hover:bg-accent hover:text-white">
              <Download className="h-3.5 w-3.5" />
            </a>
            <Btn size="sm" variant="accent" busy={busy === 'save'} disabled={!dirty} onClick={save} title="Ctrl+S">
              <Save className="h-3.5 w-3.5" /> Salvar
            </Btn>
          </div>
        </div>
        <div className={`min-h-0 flex-1 ${embedded ? '' : 'h-[calc(100vh-14rem)]'}`}>
          <Suspense fallback={<Skeleton className="h-full" />}>
            <CodeEditor value={draft} onChange={setDraft} filename={file.path} onSave={save} />
          </Suspense>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex min-h-0 flex-col rounded-lg bg-card border ${embedded ? 'h-full' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-3 py-2">
        <Crumbs />
        <div className="flex items-center gap-1">
          <input
            ref={uploadRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              upload(e.target.files)
              e.target.value = ''
            }}
          />
          <IconBtn onClick={() => uploadRef.current?.click()} title="enviar arquivos (ou arraste aqui)">
            {busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </IconBtn>
          <IconBtn onClick={() => setCreating('file')} active={creating === 'file'} title="novo arquivo">
            <FilePlus className="h-4 w-4" />
          </IconBtn>
          <IconBtn onClick={() => setCreating('dir')} active={creating === 'dir'} title="nova pasta">
            <FolderPlus className="h-4 w-4" />
          </IconBtn>
          <IconBtn onClick={load} title="atualizar">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </IconBtn>
        </div>
      </div>

      <div className={`min-h-0 overflow-auto p-1.5 ${embedded ? 'flex-1' : 'max-h-[70vh]'}`}>
        {creating && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-300">
            {creating === 'dir' ? <FolderPlus className="h-4 w-4 text-primary" /> : <FilePlus className="h-4 w-4 text-primary" />}
            <InlineInput placeholder={creating === 'dir' ? 'nome da pasta' : 'nome do arquivo'} onSubmit={createItem} onCancel={() => setCreating('')} busy={busy === 'create'} />
          </div>
        )}
        {cur !== '' && <Row onOpen={() => go(parentOf(cur))} icon={<Folder className="h-4 w-4 text-slate-400" />} name=".." muted />}
        {loading && entries.length === 0 && (
          <div className="space-y-1 p-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        )}
        {entries.length === 0 && !loading && !creating && (
          <div className="m-1.5 rounded-xl border border-dashed border-border">
            <Empty>pasta vazia — arraste arquivos aqui para enviar</Empty>
          </div>
        )}
        {entries.map((e) => {
          const Ic = e.type === 'dir' ? Folder : iconFor(e.name)
          const full = joinPath(cur, e.name)
          if (renaming === e.name) {
            return (
              <div key={e.name} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <Ic className="h-4 w-4 text-slate-400" />
                <InlineInput initial={e.name} onSubmit={(n) => renameItem(e, n)} onCancel={() => setRenaming('')} busy={busy === 'ren:' + e.name} />
              </div>
            )
          }
          if (deleting === e.name) {
            return (
              <div key={e.name} className="flex items-center gap-2 rounded-lg bg-rose-500/5 px-3 py-1.5 text-sm">
                <Trash2 className="h-4 w-4 text-rose-300" />
                <InlineConfirm text={`Excluir "${e.name}"${e.type === 'dir' ? ' e todo o conteúdo' : ''}? Sem volta.`} onYes={() => delItem(e)} onNo={() => setDeleting('')} busy={busy === 'del:' + e.name} />
              </div>
            )
          }
          return (
            <Row
              key={e.name}
              onOpen={() => go(full)}
              icon={<Ic className={`h-4 w-4 ${e.type === 'dir' ? 'text-primary' : 'text-slate-400'}`} />}
              name={e.name}
              right={
                e.outside ? (
                  <span className="font-mono text-xs text-amber-300" title="symlink que aponta para fora de /root — o painel não abre; você pode renomear ou excluir o link">
                    link p/ fora de /root
                  </span>
                ) : (
                  !embedded && (
                    <span className="hidden font-mono text-xs text-slate-500 sm:inline">
                      {e.type === 'file' ? fmtSize(e.size) + ' · ' : ''}
                      {fmtDate(e.mtime)}
                    </span>
                  )
                )
              }
              actions={
                <>
                  {e.type === 'file' && !e.outside && (
                    <a href={api.fsDownloadUrl(full)} onClick={(ev) => ev.stopPropagation()} title="baixar" className="rounded p-1 text-slate-500 hover:bg-accent hover:text-slate-200">
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setRenaming(e.name)
                    }}
                    title="renomear"
                    className="rounded p-1 text-slate-500 hover:bg-accent hover:text-slate-200"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setDeleting(e.name)
                    }}
                    title="excluir"
                    className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              }
            />
          )
        })}
      </div>
    </div>
  )
}

function Row({ onOpen, icon, name, right, actions, muted }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${muted ? 'text-slate-500' : 'text-slate-200'}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {right}
      {actions && <span className="flex items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">{actions}</span>}
    </div>
  )
}
