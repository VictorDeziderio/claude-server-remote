'use strict';
const { tr } = require('./i18n');
// Backup: status per project (read from backup.log), "backup now" (runs backup.sh), and backup of the
// CONFIG (~/.claude + ~/.claude.json): rotated local tarball (start.sh schedules it 1x/day) +
// direct download from the panel (stream `tar czf -`).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const { sh, validName, log } = require('./util');
const { listProjects } = require('./projects-list');

// backup.log has lines "[YYYY-MM-DD HH:MM:SS] ok    name: msg" / "WARN  name: ..." / "skip  name: ..."
function backupStatus() {
  const p = path.join(cfg.LOGS_DIR, 'backup.log');
  let text = '';
  try {
    const st = fs.statSync(p);
    const want = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(want);
    const fd = fs.openSync(p, 'r'); fs.readSync(fd, buf, 0, want, st.size - want); fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { /* no log yet */ }
  const byProject = {};
  let lastRun = '';
  for (const line of text.split('\n')) {
    const m = line.match(/^\[([^\]]+)\]\s+(ok|WARN|skip)\s+([^:]+):\s*(.*)$/);
    if (!m) continue;
    const [, ts, level, name, msg] = m;
    lastRun = ts;
    byProject[name.trim()] = { ts, level, msg };
  }
  const projects = listProjects().map((name) => {
    const dir = path.join(cfg.PROJECTS_DIR, name);
    let git = false, origin = '';
    try { git = fs.existsSync(path.join(dir, '.git')); } catch { /* */ }
    return { name, git, origin, last: byProject[name] || null };
  });
  // incremental copy of the volume (backup.sh --volume, logged as "(volume)": not a valid project name)
  const volume = process.env.VOLUME_BACKUP_DIR ? { dir: process.env.VOLUME_BACKUP_DIR, keep: parseInt(process.env.VOLUME_BACKUP_KEEP || '7', 10), interval: parseInt(process.env.VOLUME_BACKUP_INTERVAL || '86400', 10), last: byProject['(volume)'] || null } : null;
  return { ok: true, enabled: process.env.BACKUP_ENABLED !== 'false', interval: parseInt(process.env.BACKUP_INTERVAL || '3600', 10), lastRun, projects, volume };
}
// origin of each repo (one spawn per project; only when the backup page opens)
async function backupStatusFull() {
  const s = backupStatus();
  await Promise.all(s.projects.map(async (p) => {
    if (!p.git) return;
    const r = await sh('git', ['-C', path.join(cfg.PROJECTS_DIR, p.name), 'remote', 'get-url', 'origin']);
    p.origin = r.ok ? r.stdout.trim() : '';
    const st = await sh('git', ['-C', path.join(cfg.PROJECTS_DIR, p.name), 'status', '--porcelain']);
    p.dirty = st.ok ? st.stdout.split('\n').filter(Boolean).length : 0;
  }));
  s.configBackups = listConfigBackups();
  return s;
}
async function runBackup(name) {
  const args = [cfg.BACKUP_SCRIPT];
  if (name) { if (!validName(name)) return { ok: false, msg: tr('srv.badName') }; args.push(path.join(cfg.PROJECTS_DIR, name)); }
  const r = await sh('bash', args, { timeout: 5 * 60 * 1000, env: { ...process.env, PROJECT_FOLDER: path.basename(cfg.PROJECTS_DIR) } });
  const out = (r.stdout + r.stderr).trim().split('\n').slice(-20).join('\n');
  return { ok: r.ok, msg: r.ok ? (out || tr('srv.backupNothing')) : tr('srv.backupFailed') + out, output: out };
}
async function runConfigBackup() {
  const r = await sh('bash', [cfg.BACKUP_SCRIPT, '--config'], { timeout: 5 * 60 * 1000 });
  const out = (r.stdout + r.stderr).trim().split('\n').slice(-10).join('\n');
  return { ok: r.ok, msg: r.ok ? (out || tr('srv.configBackupDone')) : tr('srv.failed') + out, backups: listConfigBackups() };
}
function listConfigBackups() {
  try {
    return fs.readdirSync(cfg.CONFIG_BACKUP_DIR).filter((f) => /^config-.*\.tgz$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(cfg.CONFIG_BACKUP_DIR, f)); return { file: f, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
// download of an already generated tarball (validated name) or of a NEW one generated on the fly (stream)
function downloadConfig(res, file, full) {
  if (file) {
    if (!/^config-[A-Za-z0-9_.-]+\.tgz$/.test(file)) { res.writeHead(400); return res.end(tr('srv.badName')); }
    const p = path.join(cfg.CONFIG_BACKUP_DIR, file);
    let st; try { st = fs.statSync(p); } catch { res.writeHead(404); return res.end(tr('srv.notFound')); }
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(p).pipe(res);
  }
  // +PID: same reason as in backup.sh (found by @qa 2026-09-28) -- avoids a name collision if
  // two generations land in the same second
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + process.pid;
  const name = `config-${ts}${full ? '-full' : ''}.tgz`;
  const args = ['czf', '-', '-C', cfg.HOME, '--ignore-failed-read'];
  if (!full) args.push('--exclude=.claude/projects', '--exclude=.claude/logs', '--exclude=.claude/run', '--exclude=.claude/todos', '--exclude=.claude/shell-snapshots');
  args.push('.claude', '.claude.json');
  res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  const tar = spawn('tar', args, { cwd: cfg.HOME });
  tar.stdout.pipe(res);
  tar.stderr.on('data', () => {});
  tar.on('error', (e) => { log('error', 'tar', { err: e.message }); res.end(); });
  res.on('close', () => { try { tar.kill(); } catch { /* */ } });
}

module.exports = { backupStatus, backupStatusFull, runBackup, runConfigBackup, listConfigBackups, downloadConfig };
