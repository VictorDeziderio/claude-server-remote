'use strict';
// Disk use per project + cleanup of old agent work copies.
//
// Claude Code agents create one git worktree per task in <project>/.claude/worktrees/<name>.
// They are full copies of the project (node_modules included) and are rarely removed: on a real
// server they reached 100 GB in one project. This module measures them and removes the old ones
// that are SAFE to remove:
//   - older than `days` (newest change in the copy, default 7 days);
//   - no uncommitted changes (`git status --porcelain` empty) — work is never thrown away;
//   - no process running inside it (any /proc/<pid>/cwd under the copy, e.g. a dev server);
//   - only inside <project>/.claude/worktrees (no path from the client, only names that are listed).
// Removal goes through `git worktree remove` (keeps git's metadata consistent); a folder that is
// not a git worktree is deleted directly. Sizes come from `du` at low priority, cached for 10 min.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { tr } = require('./i18n');
const { sh, validName, log } = require('./util');

const CACHE_MS = 10 * 60e3;
const cache = new Map(); // dir -> { at, bytes }
const DAY = 86400e3;

async function duBytes(dir, fresh = false) {
  const c = cache.get(dir);
  if (!fresh && c && Date.now() - c.at < CACHE_MS) return c.bytes;
  // nice/ionice: on a busy server du over 100 GB must not slow down the sessions
  const r = await sh('nice', ['-n', '19', 'du', '-sxb', dir], { timeout: 300000 });
  const bytes = parseInt((r.stdout || '').split(/\s/)[0], 10);
  const v = Number.isFinite(bytes) ? bytes : null;
  if (v != null) cache.set(dir, { at: Date.now(), bytes: v });
  return v;
}

// newest mtime among the copy's top level and its git HEAD/index (cheap, no full walk)
function lastChange(dir) {
  let t = 0;
  const look = (p) => { try { t = Math.max(t, fs.statSync(p).mtimeMs); } catch { /* */ } };
  look(dir);
  try { for (const e of fs.readdirSync(dir)) if (e !== 'node_modules') look(path.join(dir, e)); } catch { /* */ }
  return t;
}

// folders some process is running in (cwd), to never remove a copy in use
function busyDirs() {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const p of pids) { try { out.push(fs.readlinkSync(`/proc/${p}/cwd`)); } catch { /* other user / gone */ } }
  return out;
}

function wtRoot(name) { return path.join(cfg.PROJECTS_DIR, name, '.claude', 'worktrees'); }

async function worktreeInfo(name, wt, busy, fresh) {
  const dir = path.join(wtRoot(name), wt);
  const isGit = fs.existsSync(path.join(dir, '.git'));
  const st = isGit ? await sh('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=normal'], { timeout: 60000 }) : { ok: true, stdout: '' };
  const br = isGit ? await sh('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']) : { stdout: '' };
  return {
    name: wt,
    bytes: await duBytes(dir, fresh),
    mtime: lastChange(dir),
    branch: br.stdout.trim(),
    dirty: !st.ok || st.stdout.trim().length > 0, // git failed -> treat as dirty (keep it)
    inUse: busy.some((d) => d === dir || d.startsWith(dir + path.sep)),
    git: isGit,
  };
}

// GET /api/disk?name=<project>&fresh=1
async function projectDisk(name, { fresh = false, days = 7 } = {}) {
  if (!validName(name) || !fs.existsSync(path.join(cfg.PROJECTS_DIR, name))) return { ok: false, msg: tr('srv.badName') };
  const busy = busyDirs();
  let names = [];
  try { names = fs.readdirSync(wtRoot(name), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no worktrees */ }
  const worktrees = [];
  for (const wt of names) worktrees.push(await worktreeInfo(name, wt, busy, fresh));
  const now = Date.now();
  for (const w of worktrees) w.removable = !w.dirty && !w.inUse && now - w.mtime > days * DAY;
  worktrees.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  const removable = worktrees.filter((w) => w.removable);
  return {
    ok: true, name, days,
    bytes: await duBytes(path.join(cfg.PROJECTS_DIR, name), fresh),
    worktreesBytes: worktrees.reduce((s, w) => s + (w.bytes || 0), 0),
    removableBytes: removable.reduce((s, w) => s + (w.bytes || 0), 0),
    removableCount: removable.length,
    worktrees,
  };
}

// POST /api/disk/clean {name, worktrees?: [names], days?}
// Without a list: every removable copy. With a list: only those of the list that are removable.
async function cleanWorktrees(name, list, days = 7) {
  const d = Number.isFinite(Number(days)) && Number(days) >= 1 ? Number(days) : 7;
  const info = await projectDisk(name, { fresh: true, days: d });
  if (!info.ok) return info;
  const want = Array.isArray(list) ? new Set(list.map(String)) : null;
  const projDir = path.join(cfg.PROJECTS_DIR, name);
  const removed = [], kept = [];
  let freed = 0;
  for (const w of info.worktrees) {
    if (want && !want.has(w.name)) continue;
    if (!w.removable) { kept.push({ name: w.name, why: w.inUse ? 'inUse' : w.dirty ? 'dirty' : 'recent' }); continue; }
    const dir = path.join(wtRoot(name), w.name);
    let ok = false;
    if (w.git) ok = (await sh('git', ['-C', projDir, 'worktree', 'remove', '--force', dir], { timeout: 300000 })).ok;
    if (!ok) { try { fs.rmSync(dir, { recursive: true, force: true }); ok = !fs.existsSync(dir); } catch { ok = false; } }
    if (w.git) await sh('git', ['-C', projDir, 'worktree', 'prune']);
    if (ok) { removed.push(w.name); freed += w.bytes || 0; cache.delete(dir); } else kept.push({ name: w.name, why: 'error' });
  }
  cache.delete(projDir);
  log('info', 'disk: worktrees cleaned', { project: name, removed: removed.length, freed });
  return { ok: true, removed, kept, freed, msg: tr('srv.disk.cleaned', { n: removed.length, size: fmtBytes(freed) }) };
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i ? v.toFixed(1) : String(v)) + ' ' + u[i];
}

module.exports = { projectDisk, cleanWorktrees, _cache: cache };
