// "Import / restore" card of the Backup page (server/restore.js):
//  - send a .tgz from this device: a config tarball of a panel, or one project folder;
//  - restore the config from an uploaded tarball or from one already on this server (a fresh
//    config backup is made first; the panel restarts by itself to load it);
//  - restore a project from an uploaded tarball or from a copy of the volume, as a new project or
//    over an existing one that is off (the old folder is moved aside, never deleted).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, RotateCcw, Trash2, FolderInput, Settings2, HardDriveDownload, Loader2 } from 'lucide-react'
import { Btn, Card, Empty, Skeleton, inputCls, useConfirm } from './ui.jsx'
import * as api from '../api.js'
import { t } from '../lib/i18n.js'
import { fmtSize, fmtDate } from '../lib/format.js'

export function RestoreCard({ onFlash, onDone }) {
  const [src, setSrc] = useState(null)
  const [up, setUp] = useState(null) // { name, pct, abort }
  const [busy, setBusy] = useState('')
  const [names, setNames] = useState({}) // restore-as name per item
  const [snap, setSnap] = useState('')
  const [confirmEl, ask] = useConfirm()
  const input = useRef(null)
  const load = useCallback(() => api.backupSources().then((r) => { setSrc(r); if (r.snapshots?.length) setSnap((s) => s || r.snapshots[0].snapshot) }).catch(() => setSrc({ ok: false })), [])
  useEffect(() => { load() }, [load])

  const pick = async (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    const job = api.backupImport(f, (p) => setUp((u) => (u ? { ...u, pct: p } : u)))
    setUp({ name: f.name, pct: 0, abort: job.abort })
    const r = await job.promise
    setUp(null)
    onFlash?.(r)
    load()
  }
  const flash = (r) => { onFlash?.(r); load(); onDone?.() }
  const doConfig = async (source, file) => {
    if (!(await ask(t('restore.configAsk', { file }), { yes: t('restore.restore'), danger: true }))) return
    setBusy('config:' + file)
    const r = await api.restoreConfig(source, file).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    flash(r)
    // the panel restarts to load the restored config: reload the page once it is back
    if (r.ok && r.restart) setTimeout(() => location.reload(), 6000)
  }
  const doProject = async (b, key, fallback) => {
    const name = (names[key] || fallback || '').trim()
    setBusy('project:' + key)
    let r = await api.restoreProject({ ...b, name }).catch((e) => ({ ok: false, msg: e.message }))
    if (!r.ok && r.exists && await ask(t('restore.replaceAsk', { name }), { yes: t('restore.replace'), danger: true })) {
      r = await api.restoreProject({ ...b, name, replace: true }).catch((e) => ({ ok: false, msg: e.message }))
    }
    setBusy('')
    if (!r.exists) flash(r)
  }
  const remove = async (f) => { const r = await api.importRemove(f.file).catch((e) => ({ ok: false, msg: e.message })); if (!r.ok) onFlash?.(r); load() }
  const nameInput = (key, fallback) => (
    <input value={names[key] ?? fallback} onChange={(e) => setNames({ ...names, [key]: e.target.value })} aria-label={t('restore.asName')} title={t('restore.asName')} className={`w-40 ${inputCls}`} data-testid="restore-name" />
  )
  const snapRow = src?.snapshots?.find((s) => s.snapshot === snap)

  return (
    <Card title={t('restore.title')} subtitle={t('restore.sub')}
      actions={<Btn size="sm" variant="accent" disabled={!!up} onClick={() => input.current?.click()}><Upload className="h-3.5 w-3.5" /> {t('restore.send')}</Btn>}>
      <input ref={input} type="file" accept=".tgz,.tar.gz,application/gzip" className="hidden" onChange={pick} data-testid="restore-file" />
      <div className="space-y-4 text-sm" data-testid="restore-card">
        <p className="text-xs text-muted-foreground">{t('restore.hint', { mb: src?.maxMb || 4096 })}</p>
        {up && (
          <div className="flex items-center gap-3 rounded-lg border p-2" data-testid="restore-progress">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="min-w-0 flex-1 truncate">{up.name}</span>
            <span className="font-mono text-xs">{Math.round(up.pct * 100)}%</span>
            <Btn size="sm" variant="ghost" onClick={up.abort}>{t('restore.cancel')}</Btn>
          </div>
        )}
        {!src ? <Skeleton className="h-16" /> : (
          <>
            <section>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restore.sent')}</h3>
              {(src.imports || []).length === 0 ? <Empty>{t('restore.noneSent')}</Empty> : (
                <ul className="divide-y divide-border">
                  {src.imports.map((f) => (
                    <li key={f.file} className="flex flex-wrap items-center gap-2 py-2" data-testid="restore-import">
                      {f.kind === 'config' ? <Settings2 className="h-4 w-4 text-muted-foreground" /> : <FolderInput className="h-4 w-4 text-muted-foreground" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{f.name}</span>
                        <span className="text-xs text-muted-foreground">{f.kind === 'config' ? t('restore.kindConfig') : t('restore.kindProject', { name: f.top })} · {fmtSize(f.size)} · {fmtDate(f.mtime)}</span>
                      </span>
                      {f.kind === 'config' ? (
                        <Btn size="sm" busy={busy === 'config:' + f.file} onClick={() => doConfig('upload', f.file)}><RotateCcw className="h-3.5 w-3.5" /> {t('restore.restoreConfig')}</Btn>
                      ) : (
                        <>
                          {nameInput(f.file, f.top)}
                          <Btn size="sm" busy={busy === 'project:' + f.file} onClick={() => doProject({ source: 'upload', file: f.file }, f.file, f.top)} data-testid="restore-project-btn"><RotateCcw className="h-3.5 w-3.5" /> {t('restore.restoreProject')}</Btn>
                        </>
                      )}
                      <Btn size="sm" variant="ghost" onClick={() => remove(f)} title={t('restore.removeSent')}><Trash2 className="h-3.5 w-3.5" /></Btn>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {(src.configs || []).length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restore.local')}</h3>
                <ul className="divide-y divide-border">
                  {src.configs.slice(0, 7).map((f) => (
                    <li key={f.file} className="flex flex-wrap items-center gap-2 py-2">
                      <Settings2 className="h-4 w-4 text-muted-foreground" />
                      <code className="min-w-0 flex-1 truncate">{f.file}</code>
                      <span className="font-mono text-xs text-muted-foreground">{fmtSize(f.size)} · {fmtDate(f.mtime)}</span>
                      <Btn size="sm" busy={busy === 'config:' + f.file} onClick={() => doConfig('local', f.file)}><RotateCcw className="h-3.5 w-3.5" /> {t('restore.restoreConfig')}</Btn>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('restore.fromVolume')}</h3>
              {!src.volume ? <p className="text-xs text-muted-foreground">{t('restore.volumeOff')}</p> : !(src.snapshots || []).length ? <Empty>{t('restore.noSnapshots')}</Empty> : (
                <div className="space-y-2">
                  <select value={snap} onChange={(e) => setSnap(e.target.value)} className={inputCls} aria-label={t('restore.fromVolume')}>
                    {src.snapshots.map((s) => <option key={s.snapshot} value={s.snapshot}>{s.snapshot} ({t('restore.nProjects', { n: s.projects.length })})</option>)}
                  </select>
                  <ul className="divide-y divide-border">
                    {(snapRow?.projects || []).map((p) => (
                      <li key={p} className="flex flex-wrap items-center gap-2 py-2" data-testid="restore-snap-project">
                        <HardDriveDownload className="h-4 w-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{p}</span>
                        {nameInput(snap + '/' + p, p)}
                        <Btn size="sm" busy={busy === 'project:' + snap + '/' + p} onClick={() => doProject({ source: 'volume', snapshot: snap, project: p }, snap + '/' + p, p)}><RotateCcw className="h-3.5 w-3.5" /> {t('restore.restoreProject')}</Btn>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </>
        )}
      </div>
      {confirmEl}
    </Card>
  )
}
