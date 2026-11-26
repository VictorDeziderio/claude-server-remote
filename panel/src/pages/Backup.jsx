import { useEffect, useState, useCallback } from 'react'
import { DatabaseBackup, Download, RefreshCw, GitBranch, AlertTriangle, CheckCircle2, Archive, Loader2, Info } from 'lucide-react'
import { Btn, Card, Empty, Skeleton } from '../components/ui.jsx'
import { fmtSize, fmtDate, fmtUptime } from '../lib/format.js'
import * as api from '../api.js'
import { RestoreCard } from '../components/RestoreCard.jsx'
import { t } from '../lib/i18n.js'
import { TR } from '../lib/i18n-rich.jsx'

// /backup — git backup status per project, "backup now", and config backup (~/.claude)
export default function BackupPage({ onFlash }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState('')
  const load = useCallback(
    () =>
      api
        .backupStatus()
        .then((r) => {
          if (r.ok) setSt(r)
        })
        .catch(() => {}),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  const run = async (name) => {
    setBusy(name || 'all')
    const r = await api.backupRun(name).catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    onFlash?.(r)
    load()
  }
  const runConfig = async () => {
    setBusy('config')
    const r = await api.backupConfig().catch((e) => ({ ok: false, msg: e.message }))
    setBusy('')
    onFlash?.(r)
    load()
  }
  const levelIcon = (l) => (l === 'ok' ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-300" /> : <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-300" />)

  return (
    <div className="space-y-5">
      <Card
        title={t('backup.projects')}
        subtitle={st ? `${st.enabled ? t('backup.auto', { every: fmtUptime(st.interval) }) : t('backup.autoOff')}${st.lastRun ? t('backup.lastRun', { when: st.lastRun }) : ''}` : ''}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Btn size="sm" variant="ghost" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Btn>
            <Btn size="sm" variant="accent" busy={busy === 'all'} onClick={() => run('')}>
              <DatabaseBackup className="h-3.5 w-3.5" /> {t('backup.all')}
            </Btn>
          </div>
        }
      >
        {!st ? (
          <Skeleton className="h-24" />
        ) : st.projects.length === 0 ? (
          <Empty>{t('projects.none')}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {st.projects.map((p) => (
              <li key={p.name} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <GitBranch className={`h-4 w-4 ${p.git && p.origin ? 'text-primary' : 'text-muted-foreground/70'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-foreground">{p.name}</span>
                    {!p.git && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t('backup.notGit')}</span>}
                    {p.git && !p.origin && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">{t('backup.noOrigin')}</span>}
                    {p.dirty ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-300">{t('backup.dirty', { n: p.dirty })}</span> : null}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {p.origin ? <code>{p.origin}</code> : p.git ? t('backup.configureOrigin') : ''}
                    {p.last && (
                      <span className="ml-2 inline-flex items-center gap-1">
                        {levelIcon(p.last.level)}
                        <span className="font-mono text-xs text-muted-foreground">{p.last.ts}</span>
                        <span className="text-muted-foreground">— {p.last.msg}</span>
                      </span>
                    )}
                  </div>
                </div>
                {p.git && p.origin && (
                  <Btn size="sm" variant="ghost" busy={busy === p.name} onClick={() => run(p.name)}>
                    <DatabaseBackup className="h-3.5 w-3.5" /> {t('backup.now')}
                  </Btn>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0" /> <span><TR k="backup.pushInfo" /></span>
        </p>
      </Card>

      <Card title={t('backup.volume')} subtitle={t('backup.volumeSub')}>
        <div className="text-sm" data-testid="volume-backup">
          {!st ? (
            <Skeleton className="h-10" />
          ) : !st.volume ? (
            <p className="text-xs text-muted-foreground"><TR k="backup.volumeOff" /></p>
          ) : (
            <div className="space-y-1 text-xs">
              <div>{t('backup.volumeDest')}: <code className="font-mono">{st.volume.dir}</code> · {t('backup.volumeKeep', { n: st.volume.keep })}</div>
              <div className={st.volume.last?.level === 'WARN' ? 'text-destructive' : 'text-muted-foreground'}>
                {st.volume.last ? `${st.volume.last.ts} — ${st.volume.last.msg}` : t('backup.volumeNever')}
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card
        title={t('backup.config')}
        subtitle={t('backup.configSub')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Btn size="sm" variant="ghost" busy={busy === 'config'} onClick={runConfig}>
              <Archive className="h-3.5 w-3.5" /> {t('backup.snapshotNow')}
            </Btn>
            <a href={api.backupDownloadUrl('', false)} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground transition duration-150 hover:bg-primary/80">
              <Download className="h-3.5 w-3.5" /> {t('backup.downloadLight')}
            </a>
            <a href={api.backupDownloadUrl('', true)} className="inline-flex items-center gap-1.5 rounded-lg bg-transparent px-3 py-1.5 text-[13px] font-medium text-foreground/80 border transition duration-150 hover:bg-accent" title={t('backup.fullTitle')}>
              <Download className="h-3.5 w-3.5" /> {t('backup.downloadFull')}
            </a>
          </div>
        }
      >
        <p className="mb-3 text-sm text-foreground/80">
          <TR k="backup.volumeWarn" />
        </p>
        {!st ? (
          <Skeleton className="h-16" />
        ) : (st.configBackups || []).length === 0 ? (
          <Empty>{t('backup.noSnapshots')}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {st.configBackups.map((b) => (
              <li key={b.file} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <Archive className="h-4 w-4 text-muted-foreground" />
                <code className="min-w-0 flex-1 truncate text-foreground">{b.file}</code>
                <span className="font-mono text-xs text-muted-foreground">
                  {fmtSize(b.size)} · {fmtDate(b.mtime)}
                </span>
                <a href={api.backupDownloadUrl(b.file)} className="inline-flex items-center gap-1.5 rounded-lg bg-transparent px-2.5 py-1 text-xs font-medium text-foreground/80 border transition duration-150 hover:bg-accent">
                  <Download className="h-3.5 w-3.5" /> {t('backup.download')}
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          <TR k="backup.restore" />
        </p>
      </Card>
      <RestoreCard onFlash={onFlash} onDone={load} />
      {busy && (
        <div className="fixed bottom-4 right-4 inline-flex items-center gap-2 rounded-lg bg-background px-3 py-2 text-xs text-foreground/80 border">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> {t('common.running')}
        </div>
      )}
    </div>
  )
}
