'use strict';
/*
 * Import / restore a backup (Backup page).
 *
 * Sources:
 *  - an uploaded .tgz (POST /api/backup/import, raw body), kept in RESTORE_DIR until removed:
 *      config  -> a config tarball of this panel (.claude/, .claude.json, .claude-accounts/);
 *      project -> one folder at the top (any name) with the files of a project;
 *  - a config tarball already on this server (~/.claude-backups/config-*.tgz);
 *  - a copy of the volume (backup.sh --volume, VOLUME_BACKUP_DIR/<date>/): one project of it.
 *
 * Config restore: first a fresh config backup of the CURRENT state (the way back), then the files
 * are merged over the home (nothing else is deleted). The panel's own login files stay as they are
 * (secret, sessions, 2FA: whoever restores is not logged out), and so do the access lists (hub
 * people, chat keys, push devices) and the run flags. The panel
 * then restarts by itself (start.sh brings it back up) to load the restored state; the tmux
 * sessions and the Claude in them keep running.
 *
 * Project restore: into a new folder, or over an existing project that is OFF (its folder is moved
 * aside to ~/.claude-backups/replaced/<name>-<date>, never deleted). The files are first unpacked /
 * copied into a stage folder; only then is the old folder moved aside (after checking again that
 * the project is off), and it is moved back if the last step fails.
 *
 * Every archive is listed with tar before anything is written: absolute paths and '..' are refused,
 * and a config tarball may only hold the config paths above.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { tr } = require('./i18n');
const { sh, validName, log } = require('./util');
const files = require('./files');

const projects = () => require('./projects');
const events = () => require('./events');
const backup = () => require('./backup');

const DIR = cfg.RESTORE_DIR;
const MAX = (parseInt(process.env.RESTORE_MAX_MB || '4096', 10) || 4096) * 1024 * 1024;
const IMPORT_RX = /^import-[0-9TZ-]+-[0-9a-f]{6}\.tgz$/;
const CONFIG_RX = /^config-[A-Za-z0-9_.-]+\.tgz$/;
const SNAP_RX = /^20\d{6}-\d{6}$/; // backup.sh --volume: <YYYYMMDD-HHMMSS>/
// never restored (see the header): the panel login state and run flags, and every ACCESS list of
// the panel (hub people, chat keys, push devices): an old backup must not bring back a key that
// was revoked since, and a backup from someone else must not bring in a key they know.
// what a config backup (backup.sh) holds: the Claude folder, its settings file and the accounts
const CONFIG_TOPS = [cfg.CLAUDE_DIR, path.join(cfg.HOME, '.claude.json'), cfg.ACCOUNTS_DIR].map((f) => path.relative(cfg.HOME, f));
const KEEP = [cfg.SECRET_FILE, cfg.SESSIONS_FILE, cfg.TOTP_FILE, cfg.RUN_DIR, cfg.HUB_FILE, cfg.CHAT_KEYS_FILE, cfg.PUSH_FILE]
  .map((f) => path.relative(cfg.HOME, f)).filter((f) => f && !f.startsWith('..'));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const rand = () => crypto.randomBytes(3).toString('hex');

// ---------------------------------------------------------------- reading an archive
// -> {ok, kind: 'config'|'project', entries, top?} | {ok:false, msg}
async function inspect(file) {
  const r = await sh('tar', ['-tzf', file], { timeout: 5 * 60 * 1000, maxBuffer: 256 * 1024 * 1024 });
  if (!r.ok) return { ok: false, msg: tr('srv.restore.notTgz') };
  const names = r.stdout.split('\n').map((s) => s.replace(/^\.\//, '')).filter((s) => s && s !== '.' && s !== './');
  if (!names.length) return { ok: false, msg: tr('srv.restore.empty') };
  if (names.some((n) => n.startsWith('/') || n.split('/').includes('..'))) return { ok: false, msg: tr('srv.restore.unsafe') };
  const tops = new Set(names.map((n) => n.split('/')[0]));
  const isConfig = [...tops].every((t) => CONFIG_TOPS.includes(t));
  if (isConfig) return { ok: true, kind: 'config', entries: names.length, hasAccounts: tops.has('.claude-accounts') };
  if (tops.size === 1) {
    const top = [...tops][0];
    if (validName(top) && names.some((n) => n.startsWith(top + '/'))) return { ok: true, kind: 'project', entries: names.length, top };
  }
  return { ok: false, msg: tr('srv.restore.unknownKind') };
}

// ---------------------------------------------------------------- sources
function importsList() {
  try {
    return fs.readdirSync(DIR).filter((f) => IMPORT_RX.test(f)).map((f) => {
      const p = path.join(DIR, f);
      const st = fs.statSync(p);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(p + '.json', 'utf8')); } catch { /* no meta */ }
      return { file: f, size: st.size, mtime: st.mtimeMs, name: meta.name || f, kind: meta.kind || '', top: meta.top || '', entries: meta.entries || 0 };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
const volumeDir = () => process.env.VOLUME_BACKUP_DIR || '';
// projects folder inside a volume copy (the copy is of the home: same relative path)
// ('' when the projects folder is not inside the home: then the copy does not have it)
const PROJ_REL = path.relative(cfg.HOME, cfg.PROJECTS_DIR);
const snapProjects = (snap) => (PROJ_REL.startsWith('..') || path.isAbsolute(PROJ_REL) ? '' : path.join(volumeDir(), snap, PROJ_REL));
function snapshots() {
  const d = volumeDir();
  if (!d) return [];
  try {
    return fs.readdirSync(d).filter((s) => SNAP_RX.test(s)).sort().reverse().slice(0, 30).map((s) => {
      let list = [];
      try { list = !snapProjects(s) ? [] : fs.readdirSync(snapProjects(s), { withFileTypes: true }).filter((e) => e.isDirectory() && validName(e.name)).map((e) => e.name).sort(); } catch { /* none */ }
      return { snapshot: s, projects: list };
    });
  } catch { return []; }
}
function sources() {
  return { ok: true, imports: importsList(), configs: backup().listConfigBackups(), snapshots: snapshots(), volume: !!volumeDir(), maxMb: MAX / 1024 / 1024 };
}
// file of a source -> full path | ''
function fileOf(source, file) {
  if (source === 'upload' && IMPORT_RX.test(file || '')) return path.join(DIR, file);
  if (source === 'local' && CONFIG_RX.test(file || '')) return path.join(cfg.CONFIG_BACKUP_DIR, file);
  return '';
}

// ---------------------------------------------------------------- upload
async function upload(req, name) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = `import-${stamp()}-${rand()}.tgz`;
  const full = path.join(DIR, file);
  const r = await files.streamUpload(full, req, false, { max: MAX });
  if (!r.ok) return r;
  const info = await inspect(full);
  if (!info.ok) { fs.rmSync(full, { force: true }); return info; }
  const meta = { name: String(name || '').slice(0, 120) || file, kind: info.kind, top: info.top || '', entries: info.entries };
  fs.writeFileSync(full + '.json', JSON.stringify(meta), { mode: 0o600 });
  return { ok: true, file, size: r.size, ...meta, msg: tr(info.kind === 'config' ? 'srv.restore.gotConfig' : 'srv.restore.gotProject', { n: info.entries, name: info.top || '' }) };
}
function removeImport(b) {
  const f = b && b.file;
  if (!IMPORT_RX.test(f || '')) return { ok: false, msg: tr('srv.badName') };
  fs.rmSync(path.join(DIR, f), { force: true });
  fs.rmSync(path.join(DIR, f + '.json'), { force: true });
  return { ok: true };
}

// ---------------------------------------------------------------- restore
let busy = false;
const once = async (fn) => {
  if (busy) return { ok: false, msg: tr('srv.restore.busy') };
  busy = true;
  try { return await fn(); } finally { busy = false; }
};
const stageDir = () => { const d = path.join(DIR, `stage-${stamp()}-${rand()}`); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const extract = (file, dest, extra = []) => sh('tar', ['-xzf', file, '-C', dest, '--no-same-owner', '--no-same-permissions', ...extra], { timeout: 30 * 60 * 1000 });

// the panel reloads everything it caches (keys, accounts, settings...) by restarting; start.sh
// brings it back. PANEL_NO_SELF_RESTART=1 (tests) leaves it running.
// -> whether it restarts
function restartPanel() {
  if (process.env.PANEL_NO_SELF_RESTART === '1') return false;
  log('info', 'restore: restarting the panel to load the restored config');
  setTimeout(() => process.exit(0), 1500).unref();
  return true;
}

function restoreConfig(b) {
  return once(async () => {
    const src = fileOf(b && b.source, b && b.file);
    if (!src || !fs.existsSync(src)) return { ok: false, msg: tr('srv.notFound') };
    const info = await inspect(src);
    if (!info.ok) return info;
    if (info.kind !== 'config') return { ok: false, msg: tr('srv.restore.notConfig') };
    const stage = stageDir();
    try {
      // a copy of the chosen file first: the safety backup below rotates the config backups and
      // may delete the oldest one, which can be the very file being restored
      const file = path.join(stage, 'source.tgz');
      fs.copyFileSync(src, file);
      // the way back: a NEW config backup of the current state. backup.sh exits 0 when it skips
      // (lock taken, low memory), so "ok" is not enough: a new file must have appeared.
      const before = new Set(backup().listConfigBackups().map((x) => x.file));
      const safety = await backup().runConfigBackup();
      const fresh = (backup().listConfigBackups()).find((x) => !before.has(x.file));
      if (!safety.ok || !fresh) return { ok: false, msg: tr('srv.restore.safetyFailed') + ' ' + (safety.msg || '') };
      const out = path.join(stage, 'files');
      fs.mkdirSync(out);
      const x = await extract(file, out, KEEP.map((k) => `--exclude=${k}`));
      if (!x.ok) return { ok: false, msg: tr('srv.restore.extractFailed') + ' ' + x.stderr.trim().slice(-300) };
      for (const k of KEEP) fs.rmSync(path.join(out, k), { recursive: true, force: true });
      const c = await sh('cp', ['-a', out + '/.', cfg.HOME + '/'], { timeout: 30 * 60 * 1000 });
      if (!c.ok) return { ok: false, msg: tr('srv.restore.copyFailed') + ' ' + c.stderr.trim().slice(-300) };
      const restart = restartPanel();
      return { ok: true, restart, safety: fresh.file, msg: tr('srv.restore.configDone', { n: info.entries, safety: fresh.file }) };
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });
}

async function moveAside(name) {
  const dest = path.join(cfg.CONFIG_BACKUP_DIR, 'replaced', `${name}-${stamp()}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await sh('mv', [path.join(cfg.PROJECTS_DIR, name), dest], { timeout: 30 * 60 * 1000 });
  return r.ok ? dest : '';
}
// b: {source: 'upload', file, name?, replace?} | {source: 'volume', snapshot, project, name?, replace?}
function restoreProject(b) {
  return once(async () => {
    b = b || {};
    let from = '', top = '', file = '';
    if (b.source === 'volume') {
      if (!volumeDir() || !SNAP_RX.test(b.snapshot || '') || !validName(b.project)) return { ok: false, msg: tr('srv.badParams') };
      if (!snapProjects(b.snapshot)) return { ok: false, msg: tr('srv.notFound') };
      from = path.join(snapProjects(b.snapshot), b.project);
      if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) return { ok: false, msg: tr('srv.notFound') };
      top = b.project;
    } else {
      file = fileOf(b.source, b.file);
      if (!file || !fs.existsSync(file)) return { ok: false, msg: tr('srv.notFound') };
      const info = await inspect(file);
      if (!info.ok) return info;
      if (info.kind !== 'project') return { ok: false, msg: tr('srv.restore.notProject') };
      top = info.top;
    }
    const name = String(b.name || top).trim();
    if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
    const target = path.join(cfg.PROJECTS_DIR, name);
    const exists = fs.existsSync(target);
    if (exists && !b.replace) return { ok: false, exists: true, msg: tr('srv.restore.exists', { name }) };
    const isOn = async () => {
      const st = await events().currentState();
      const live = st && st.projects && st.projects.find((x) => x.name === name);
      return projects().projConfig(name).enabled || !!(live && live.up);
    };
    if (exists && await isOn()) return { ok: false, msg: tr('srv.restore.turnOff', { name }) };
    const stage = stageDir();
    try {
      const ready = path.join(stage, 'project');
      if (from) {
        const c = await sh('cp', ['-a', from, ready], { timeout: 60 * 60 * 1000 });
        if (!c.ok) return { ok: false, msg: tr('srv.restore.copyFailed') + ' ' + c.stderr.trim().slice(-300) };
      } else {
        const x = await extract(file, stage);
        if (!x.ok) return { ok: false, msg: tr('srv.restore.extractFailed') + ' ' + x.stderr.trim().slice(-300) };
        fs.renameSync(path.join(stage, top), ready);
      }
      // checked again: it may have been turned on while the files were unpacked
      let replaced = '';
      if (fs.existsSync(target)) {
        if (await isOn()) return { ok: false, msg: tr('srv.restore.turnOff', { name }) };
        replaced = await moveAside(name);
        if (!replaced) return { ok: false, msg: tr('srv.restore.copyFailed') };
      }
      // OFF: an unknown project would get the defaults (on + Claude in bypassPermissions) and
      // start Claude by itself on imported code
      const conf = projects().loadConfig();
      conf.projects = conf.projects || {};
      conf.projects[name] = { ...(conf.projects[name] || {}), enabled: false };
      projects().saveConfig(conf);
      const m = await sh('mv', [ready, target], { timeout: 60 * 60 * 1000 });
      if (!m.ok) {
        if (replaced) await sh('mv', [replaced, target], { timeout: 60 * 60 * 1000 });
        return { ok: false, msg: tr('srv.restore.copyFailed') + ' ' + m.stderr.trim().slice(-300) };
      }
      try { events().poke(); } catch { /* */ }
      return { ok: true, name, replaced, msg: tr(replaced ? 'srv.restore.projectReplaced' : 'srv.restore.projectDone', { name, old: replaced }) };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
}

const routes = {
  GET: { '/api/backup/sources': async () => sources() },
  POST: {
    '/api/backup/restore/config': (b) => restoreConfig(b),
    '/api/backup/restore/project': (b) => restoreProject(b),
    '/api/backup/import/remove': (b) => removeImport(b),
  },
  AUDITED: ['/api/backup/restore/config', '/api/backup/restore/project', '/api/backup/import/remove'],
};

// stage folders left by a restore cut short (panel restart, crash): removed at boot
try { for (const f of fs.readdirSync(DIR)) if (f.startsWith('stage-')) fs.rmSync(path.join(DIR, f), { recursive: true, force: true }); } catch { /* no dir yet */ }

module.exports = { routes, upload, inspect, sources };
