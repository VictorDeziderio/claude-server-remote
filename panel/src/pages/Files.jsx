import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Folder, FileText, RefreshCw, Save, Trash2, FilePlus, FolderPlus, Home, Loader2, ChevronRight,
  Pencil, ArrowLeft, Download, Upload, FileCode2, FileImage, FileArchive,
} from 'lucide-react'
import { Btn, IconBtn, Empty } from '../components/ui.jsx'
import { fmtSize, fmtDate, joinPath, parentOf } from '../lib/format.js'
import * as api from '../api.js'

const iconFor = (name) => {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return FileImage
  if (['zip', 'tar', 'gz', 'tgz', 'xz', '7z', 'rar'].includes(ext)) return FileArchive
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'sh', 'json', 'yml', 'yaml', 'toml', 'css', 'html', 'sql', 'go', 'rs', 'java'].includes(ext)) return FileCode2
  return FileText
}
const enc = (p) => p.split('/').map(encodeURIComponent).join('/')

// /files/<caminho relativo a /root>. Pasta -> lista; arquivo -> editor. A URL e a fonte da verdade.
export default function Files({ onFlash }) {
  const { '*': raw = '' } = useParams()
  const navigate = useNavigate()
  const cur = raw.replace(/^\/+|\/+$/g, '')
  const go = useCallback((p) => navigate('/files' + (p ? '/' + enc(p) : '')), [navigate])

  const [kind, setKind] = useState('') // '' | dir | file
  const [entries, setEntries] = useState([])
  const [file, setFile] = useState(null) // { path, size, mtime }
  const [draft, setDraft] = useState('')
  const [orig, setOrig] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const uploadRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const st = await api.fsStat(cur)
      if (!st.ok) { onFlash?.({ ok: false, msg: `${cur || '/'}: ${st.msg}` }); if (cur) go(parentOf(cur)); return }
      if (st.type === 'dir') {
        const r = await api.fsList(cur)
        if (!r.ok) { onFlash?.({ ok: false, msg: r.msg }); return }
        setKind('dir'); setEntries(r.entries); setFile(null)
      } else {
        const r = await api.fsRead(cur)
        if (!r.ok) {
          onFlash?.({ ok: false, msg: r.msg })
          if (r.code === 'BINARY' || r.code === 'TOOBIG') window.open(api.fsDownloadUrl(cur), '_blank')
          go(parentOf(cur)); return
        }
        setKind('file'); setFile({ path: r.path, size: r.size, mtime: r.mtime }); setDraft(r.content); setOrig(r.content)
      }
    } catch (e) { onFlash?.({ ok: false, msg: e.message }) }
    finally { setLoading(false) }
  }, [cur, go, onFlash])
  useEffect(() => { load() }, [load])

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
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && kind === 'file') { e.preventDefault(); save() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [kind, save])
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const newItem = async (k) => {
    const name = window.prompt(k === 'dir' ? 'Nome da nova pasta:' : 'Nome do novo arquivo:')
    if (!name) return
    const r = await api.fsCreate(joinPath(cur, name), k)
    onFlash?.(r); if (r.ok) (k === 'dir' ? load() : go(r.path))
  }
  const del = async (e) => {
    if (!window.confirm(`Excluir "${e.name}"${e.type === 'dir' ? ' e todo o conteúdo' : ''}? Isso é permanente.`)) return
    const r = await api.fsDelete(joinPath(cur, e.name))
    onFlash?.(r); if (r.ok) load()
  }
  const rename = async (e) => {
    const name = window.prompt('Novo nome:', e.name)
    if (!name || name === e.name) return
    const r = await api.fsRename(joinPath(cur, e.name), joinPath(cur, name))
    onFlash?.(r); if (r.ok) load()
  }
  const upload = async (files) => {
    if (!files || !files.length) return
    setBusy('upload')
    let okN = 0
    for (const f of files) {
      const target = joinPath(cur, f.name)
      let r = await api.fsUpload(target, f, false)
      if (!r.ok && /ja existe/.test(r.msg) && window.confirm(`"${f.name}" já existe. Sobrescrever?`)) r = await api.fsUpload(target, f, true)
      if (r.ok) okN++; else onFlash?.(r)
    }
    setBusy('')
    if (okN) onFlash?.({ ok: true, msg: `${okN} arquivo(s) enviado(s) para /root/${cur || ''}` })
    load()
  }
  const onDrop = (e) => { e.preventDefault(); if (kind === 'dir') upload(e.dataTransfer?.files) }

  const parts = cur ? cur.split('/') : []
  const Crumbs = () => (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-slate-300">
      <Link to="/files" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/5" title="/root"><Home className="h-3.5 w-3.5 text-claude" /> root</Link>
      {parts.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
          {i === parts.length - 1
            ? <span className="px-1.5 py-0.5 text-slate-100">{seg}</span>
            : <Link to={'/files/' + enc(parts.slice(0, i + 1).join('/'))} className="rounded px-1.5 py-0.5 hover:bg-white/5">{seg}</Link>}
        </span>
      ))}
    </div>
  )

  if (kind === 'file' && file) {
    return (
      <div className="flex h-full min-h-[60vh] flex-col rounded-2xl bg-ink-800 ring-1 ring-white/5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <Btn onClick={() => go(parentOf(cur))}><ArrowLeft className="h-3.5 w-3.5" /> Voltar</Btn>
            <Crumbs />
            {dirty && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">não salvo</span>}
            <span className="text-[11px] text-slate-500">{fmtSize(file.size)} · {fmtDate(file.mtime)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <a href={api.fsDownloadUrl(file.path)} className="inline-flex items-center gap-1.5 rounded-lg bg-ink-500 px-3 py-1.5 text-[13px] font-medium text-slate-100 transition hover:bg-ink-500/70" title="baixar"><Download className="h-3.5 w-3.5" /> Baixar</a>
            <Btn variant="accent" busy={busy === 'save'} disabled={!dirty} onClick={save} title="Ctrl+S"><Save className="h-3.5 w-3.5" /> Salvar</Btn>
          </div>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); const t = e.target; const s = t.selectionStart, en = t.selectionEnd; setDraft(draft.slice(0, s) + '  ' + draft.slice(en)); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2 }) } }}
          className="min-h-[55vh] w-full flex-1 resize-none rounded-b-2xl bg-ink-900 p-4 font-mono text-[13px] leading-relaxed text-slate-200 focus:outline-none"
        />
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-ink-800 ring-1 ring-white/5" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
        <Crumbs />
        <div className="flex items-center gap-1.5">
          <input ref={uploadRef} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = '' }} />
          <IconBtn onClick={() => uploadRef.current?.click()} title="enviar arquivos (ou arraste aqui)">{busy === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}</IconBtn>
          <IconBtn onClick={() => newItem('file')} title="novo arquivo"><FilePlus className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => newItem('dir')} title="nova pasta"><FolderPlus className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={load} title="atualizar">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</IconBtn>
        </div>
      </div>

      <div className="max-h-[70vh] overflow-auto p-2">
        {cur !== '' && <Row to={'/files' + (parentOf(cur) ? '/' + enc(parentOf(cur)) : '')} icon={<Folder className="h-4 w-4 text-slate-400" />} name=".." muted />}
        {entries.length === 0 && !loading && <Empty>pasta vazia — arraste arquivos aqui para enviar</Empty>}
        {entries.map((e) => {
          const Ic = e.type === 'dir' ? Folder : iconFor(e.name)
          return (
            <Row key={e.name} to={'/files/' + enc(joinPath(cur, e.name))}
              icon={<Ic className={`h-4 w-4 ${e.type === 'dir' ? 'text-claude' : 'text-slate-400'}`} />}
              name={e.name}
              right={<span className="hidden text-[11px] text-slate-500 sm:inline">{e.type === 'file' ? fmtSize(e.size) + ' · ' : ''}{fmtDate(e.mtime)}</span>}
              actions={
                <>
                  {e.type === 'file' && <a href={api.fsDownloadUrl(joinPath(cur, e.name))} onClick={(ev) => ev.stopPropagation()} title="baixar" className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"><Download className="h-3.5 w-3.5" /></a>}
                  <button type="button" onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); rename(e) }} title="renomear" className="rounded p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"><Pencil className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); del(e) }} title="excluir" className="rounded p-1 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
                </>
              }
            />
          )
        })}
      </div>
    </div>
  )
}

function Row({ to, icon, name, right, actions, muted }) {
  return (
    <Link to={to} className={`group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition hover:bg-white/5 ${muted ? 'text-slate-500' : 'text-slate-200'}`}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {right}
      {actions && <span className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">{actions}</span>}
    </Link>
  )
}
