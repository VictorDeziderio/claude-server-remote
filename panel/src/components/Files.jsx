import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react'
import { Folder, FileText, RefreshCw, Save, Trash2, FilePlus, FolderPlus, Home, Loader2, ChevronRight, Pencil, ArrowLeft, Download, Upload, FileCode2, FileImage, FileArchive } from 'lucide-react'
import { Btn, IconBtn, Empty, InlineConfirm, InlineInput, Skeleton, useConfirm } from './ui.jsx'
import { Button } from './ui/button.jsx'
import { fmtSize, fmtDate, joinPath, parentOf } from '../lib/format.js'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'
import { FileViewer, viewKind } from './FileViewer.jsx'

const CodeEditor = lazy(() => import('./CodeEditor.jsx'))

const iconFor = (name) => {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return FileImage
  if (['zip', 'tar', 'gz', 'tgz', 'xz', '7z', 'rar'].includes(ext)) return FileArchive
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'sh', 'json', 'yml', 'yaml', 'toml', 'css', 'html', 'sql', 'go', 'rs', 'java'].includes(ext)) return FileCode2
  return FileText
}

// File manager. `path` + `onNavigate` come from outside (URL on the page, local state when
// embedded in the terminal). Folder -> list; file -> editor (CodeMirror, loaded on demand).
// path breadcrumb of the file browser
function Crumbs({ parts, go, embedded }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm">
      <button type="button" onClick={() => go('')} title="/root" aria-label="/root" className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-accent ${parts.length === 0 ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground/80'}`}>
        <Home className="h-3.5 w-3.5 text-primary" /> {!embedded && 'root'}
      </button>
      {parts.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          {i === parts.length - 1 ? (
            <span className="max-w-[12rem] truncate px-1.5 py-0.5 font-medium text-foreground">{seg}</span>
          ) : (
            <button type="button" onClick={() => go(parts.slice(0, i + 1).join('/'))} className="max-w-[10rem] truncate rounded px-1.5 py-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground/80">
              {seg}
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

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
  const [renaming, setRenaming] = useState('') // entry name
  const [deleting, setDeleting] = useState('') // entry name
  const [viewing, setViewing] = useState(-1) // index in `viewable` of the file open in the viewer
  const [confirmEl, ask] = useConfirm()
  const uploadRef = useRef(null)
  const pendingView = useRef('')

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
          if (!((r.code === 'BINARY' || r.code === 'TOOBIG') && viewKind(cur))) onFlash?.({ ok: false, msg: r.msg })
          // a link straight to an image/PDF/video: open its folder with the viewer on it
          if ((r.code === 'BINARY' || r.code === 'TOOBIG') && viewKind(cur)) pendingView.current = cur
          else if (r.code === 'BINARY' || r.code === 'TOOBIG') window.open(api.fsDownloadUrl(cur), '_blank')
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

  // images / PDF / video / audio of this folder, in list order: the viewer steps through them
  const viewable = kind === 'dir' ? entries.filter((e) => e.type === 'file' && !e.outside && viewKind(e.name)).map((e) => ({ name: e.name, path: joinPath(cur, e.name), size: e.size })) : []
  useEffect(() => setViewing(-1), [cur])
  useEffect(() => {
    if (!pendingView.current) return
    const i = viewable.findIndex((x) => x.path === pendingView.current)
    if (i >= 0) { pendingView.current = ''; setViewing(i) }
  }, [entries]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = kind === 'file' && draft !== orig
  // leaving the editor with unsaved edits (back, breadcrumb) asks first in the panel's modal
  const leave = useCallback(async (p) => {
    if (dirty && !(await ask(t('files.discardAsk', { name: file?.path || cur }), { yes: t('files.discard'), danger: true }))) return
    go(p)
  }, [dirty, ask, go, file, cur])
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
      if (!r.ok && r.code === 'EXISTS' && (await ask(t('files.overwrite', { name: f.name }), { yes: t('files.overwriteYes') }))) r = await api.fsUpload(target, f, true)
      if (r.ok) okN++
      else onFlash?.(r)
    }
    setBusy('')
    if (okN) onFlash?.({ ok: true, msg: t('files.uploaded', { n: okN, dir: cur || '' }) })
    load()
  }
  const onDrop = (e) => {
    e.preventDefault()
    if (kind === 'dir') upload(e.dataTransfer?.files)
  }

  const parts = cur ? cur.split('/') : []

  if (kind === 'file' && file) {
    return (
      <div className={`flex h-full min-h-0 flex-col rounded-lg bg-card border ${embedded ? '' : 'min-h-[60vh]'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Btn size="sm" onClick={() => leave(parentOf(cur))} title={t('common.back')}>
              <ArrowLeft className="h-3.5 w-3.5" /> {!embedded && t('common.back')}
            </Btn>
            <Crumbs parts={parts} go={leave} embedded={embedded} />
            {dirty && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-300">{t('files.unsaved')}</span>}
            {!embedded && (
              <span className="font-mono text-xs text-muted-foreground">
                {fmtSize(file.size)} · {fmtDate(file.mtime)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button asChild variant="secondary" size="icon-sm" title={t('files.download')}>
              <a href={api.fsDownloadUrl(file.path)}>
                <Download className="h-3.5 w-3.5" />
              </a>
            </Button>
            <Btn size="sm" variant="accent" busy={busy === 'save'} disabled={!dirty} onClick={save} title="Ctrl+S">
              <Save className="h-3.5 w-3.5" /> {t('common.save')}
            </Btn>
          </div>
        </div>
        <div className={`min-h-0 flex-1 ${embedded ? '' : 'h-[calc(100vh-14rem)]'}`}>
          <Suspense fallback={<Skeleton className="h-full" />}>
            <CodeEditor value={draft} onChange={setDraft} filename={file.path} onSave={save} />
          </Suspense>
        </div>
        {confirmEl}
      </div>
    )
  }

  return (
    <div className={`flex min-h-0 flex-col rounded-lg bg-card border ${embedded ? 'h-full' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <Crumbs parts={parts} go={go} embedded={embedded} />
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
          <IconBtn onClick={() => uploadRef.current?.click()} title={t('files.upload')}>
            {busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </IconBtn>
          <IconBtn onClick={() => setCreating('file')} active={creating === 'file'} title={t('files.newFile')}>
            <FilePlus className="h-4 w-4" />
          </IconBtn>
          <IconBtn onClick={() => setCreating('dir')} active={creating === 'dir'} title={t('files.newDir')}>
            <FolderPlus className="h-4 w-4" />
          </IconBtn>
          <IconBtn onClick={load} title={t('common.refresh')}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </IconBtn>
        </div>
      </div>

      <div className={`min-h-0 overflow-auto p-1.5 ${embedded ? 'flex-1' : 'max-h-[70vh]'}`}>
        {creating && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-foreground/80">
            {creating === 'dir' ? <FolderPlus className="h-4 w-4 text-primary" /> : <FilePlus className="h-4 w-4 text-primary" />}
            <InlineInput placeholder={creating === 'dir' ? t('files.dirName') : t('files.fileName')} onSubmit={createItem} onCancel={() => setCreating('')} busy={busy === 'create'} />
          </div>
        )}
        {cur !== '' && <Row onOpen={() => go(parentOf(cur))} icon={<Folder className="h-4 w-4 text-muted-foreground" />} name=".." muted />}
        {loading && entries.length === 0 && (
          <div className="space-y-1 p-2">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        )}
        {entries.length === 0 && !loading && !creating && (
          <div className="m-1.5 rounded-xl border border-dashed border-border">
            <Empty>{t('files.empty')}</Empty>
          </div>
        )}
        {entries.map((e) => {
          const Ic = e.type === 'dir' ? Folder : iconFor(e.name)
          const full = joinPath(cur, e.name)
          if (renaming === e.name) {
            return (
              <div key={e.name} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <Ic className="h-4 w-4 text-muted-foreground" />
                <InlineInput initial={e.name} onSubmit={(n) => renameItem(e, n)} onCancel={() => setRenaming('')} busy={busy === 'ren:' + e.name} />
              </div>
            )
          }
          if (deleting === e.name) {
            return (
              <div key={e.name} className="flex items-center gap-2 rounded-lg bg-rose-500/5 px-3 py-1.5 text-sm">
                <Trash2 className="h-4 w-4 text-rose-600 dark:text-rose-300" />
                <InlineConfirm text={t(e.type === 'dir' ? 'files.confirmDeleteDir' : 'files.confirmDelete', { name: e.name })} onYes={() => delItem(e)} onNo={() => setDeleting('')} busy={busy === 'del:' + e.name} />
              </div>
            )
          }
          return (
            <Row
              key={e.name}
              onOpen={() => { const v = e.type === 'file' && !e.outside ? viewable.findIndex((x) => x.path === full) : -1; if (v >= 0) setViewing(v); else go(full) }}
              icon={<Ic className={`h-4 w-4 ${e.type === 'dir' ? 'text-primary' : 'text-muted-foreground'}`} />}
              name={e.name}
              right={
                e.outside ? (
                  <span className="text-xs text-amber-600 dark:text-amber-300" title={t('files.outsideTitle')}>
                    {t('files.outside')}
                  </span>
                ) : (
                  !embedded && (
                    <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                      {e.type === 'file' ? fmtSize(e.size) + ' · ' : ''}
                      {fmtDate(e.mtime)}
                    </span>
                  )
                )
              }
              actions={
                <>
                  {e.type === 'file' && !e.outside ? (
                    <a href={api.fsDownloadUrl(full)} onClick={(ev) => ev.stopPropagation()} title={t('files.download')} aria-label={t('files.download')} className={ACT}>
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span aria-hidden="true" className={`pointer-events-none opacity-0 ${ACT_BASE}`}>
                      <Download className="h-3.5 w-3.5" />
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setRenaming(e.name)
                    }}
                    title={t('files.rename')}
                    aria-label={t('files.rename')}
                    className={ACT}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setDeleting(e.name)
                    }}
                    title={t('files.delete')}
                    aria-label={t('files.delete')}
                    className={`${ACT_BASE} hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-300`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              }
            />
          )
        })}
      </div>
      {confirmEl}
      {viewing >= 0 && viewable[viewing] && <FileViewer items={viewable} index={viewing} onIndex={setViewing} onClose={() => setViewing(-1)} />}
    </div>
  )
}

// row action button (download / rename / delete): small on a mouse, a >= 40px target on a finger
const ACT_BASE = 'inline-flex items-center justify-center rounded p-1 text-muted-foreground pointer-coarse:size-10'
const ACT = `${ACT_BASE} hover:bg-accent hover:text-foreground`

// A row of the listing. Its actions show on hover with a mouse; on a touch screen there is no
// hover, so they stay visible (pointer-coarse).
function Row({ onOpen, icon, name, right, actions, muted }) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="file-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return // keys typed on an action button are its own
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${muted ? 'text-muted-foreground' : 'text-foreground'}`}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {right}
      {actions && <span data-testid="row-actions" className="flex items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">{actions}</span>}
    </div>
  )
}
