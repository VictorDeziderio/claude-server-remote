'use strict';
const { tr } = require('./i18n');
// Projects: config (panel.json), tmux sessions per project, actions (create/rename/delete/
// restart/remote/first line) and the consolidated dashboard state.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sh, validName, sessionName, paneOf, truthy, log, typeLine } = require('./util');
const { listProjects } = require('./projects-list');
const { loginInfo, claudeVersion } = require('./claude');
const events = require('./events');
const accounts = require('./accounts');
const history = require('./history'); // safe at the top: history.js only requires ./projects LAZILY (inside a function)

const remoteCmdFor = (name) => '/remote-control ' + (cfg.REMOTE_CONTROL_NAME || name);

// ---------- config (panel.json) ----------
// enabled: project ON (session starts at boot and the watchdog keeps it) | autoStartClaude: the session
// runs Claude | autoRemote: turns /remote-control back on at each Claude start (claude-loop.sh)
const FLAGS = ['enabled', 'autoStartClaude', 'autoRemote'];
const DEFAULTS = { enabled: true, autoStartClaude: true, autoRemote: true, idlePauseHours: 0 };
const SESSION_MODES = new Set(['new', 'continue', 'pinned']);
const PINNED_ID_RX = /^[A-Za-z0-9_-]{6,80}$/;
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(cfg.CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object') { c.defaults = { ...DEFAULTS, ...(c.defaults || {}) }; c.projects = c.projects || {}; c.settings = c.settings || {}; return c; }
  } catch { /* ausente/invalido -> defaults */ }
  return { defaults: { ...DEFAULTS }, projects: {}, settings: {} };
}
function saveConfig(c) {
  try {
    fs.mkdirSync(path.dirname(cfg.CONFIG_FILE), { recursive: true });
    const tmp = cfg.CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
    fs.renameSync(tmp, cfg.CONFIG_FILE); // atomic write (claude-session.sh reads this file)
    return true;
  } catch (e) { log('error', 'erro salvando panel.json', { err: e.message }); return false; }
}
// same derivation as projConfig, but from a `c` (loadConfig()) already loaded — used in
// buildState (watcher hot path) so panel.json is not reread from disk once per project on each tick
function configFrom(c, name) {
  const d = c.defaults || {};
  const p = (c.projects && c.projects[name]) || {};
  // same rule as devbox-lib.sh (proj_config): only an explicit `false` turns it off
  const pick = (k) => (k in p ? p[k] !== false : (k in d ? d[k] !== false : true));
  const numOr = (v, fallback) => (typeof v === 'number' && v >= 0 ? v : fallback);
  return {
    enabled: pick('enabled'),
    autoStartClaude: pick('autoStartClaude'),
    autoRemote: pick('autoRemote'),
    initLine: typeof p.initLine === 'string' ? p.initLine : '', // "first line" sent to Claude when it is ready
    // sessionMode: 'new' (starts from zero) | 'continue' (claude --continue) | 'pinned' (fixed --resume <id>)
    sessionMode: SESSION_MODES.has(p.sessionMode) ? p.sessionMode : 'new',
    pinnedSession: typeof p.pinnedSession === 'string' ? p.pinnedSession : '',
    // 0 = off; per-project override, otherwise the panel.json default, otherwise 0
    idlePauseHours: numOr(p.idlePauseHours, numOr(d.idlePauseHours, 0)),
    // Claude account (server/accounts.js) — same rule as devbox-lib.sh (proj_config)
    account: typeof p.account === 'string' && accounts.ID_RX.test(p.account) ? p.account : accounts.DEFAULT,
  };
}
function projConfig(name) { return configFrom(loadConfig(), name); }
function setProjConfig(name, patch) {
  const c = loadConfig();
  c.projects = c.projects || {};
  c.projects[name] = Object.assign({}, c.projects[name], patch);
  return saveConfig(c);
}

// ---------- tmux session ----------
const sessionUp = async (sess) => (await sh('tmux', ['has-session', '-t', '=' + sess])).ok;
// starts the project session IF it is on (the script respects enabled=false)
const ensureSession = (name) => sh('bash', [cfg.SESSION_SCRIPT, name]);
async function killSession(name) {
  const sess = sessionName(name);
  await sh('tmux', ['kill-session', '-t', '=' + sess]);
  try { fs.rmSync(path.join(cfg.RUN_DIR, sess + '.running'), { force: true }); } catch { /* */ }
}
// recreates the session from scratch (closes remote + Claude) with the current config.
// Locks with a sentinel in RUN_DIR (found by @qa 2026-09-28) only during the kill: without it, the
// start.sh watchdog (claude-session.sh --all, every 10s) could see the session already
// dead and recreate it BEFORE the ensureSession here ran (race). The lock is released BEFORE
// ensureSession (it does not wrap the whole call): ensureSession calls the SAME
// claude-session.sh that respects the lock, so holding it during ensureSession itself
// would block the panel from recreating its own session (deadlock — caught by the smoke test).
async function recreateSession(name) {
  const sess = sessionName(name);
  const lock = path.join(cfg.RUN_DIR, sess + '.lock');
  try { fs.mkdirSync(cfg.RUN_DIR, { recursive: true }); fs.writeFileSync(lock, String(process.pid)); } catch { /* */ }
  try {
    await killSession(name);
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch { /* */ }
  }
  await ensureSession(name);
}
const projectExists = (name) => validName(name) && fs.existsSync(path.join(cfg.PROJECTS_DIR, name));
// Claude really running in this session? flag file kept by claude-loop.sh
function claudeRunningFlag(sess) {
  try { return fs.existsSync(path.join(cfg.RUN_DIR, sess + '.running')); } catch { return false; }
}
// paused (by hand or for inactivity)? claude-loop.sh does not reopen Claude while the flag exists
const pausedFlagPath = (sess) => path.join(cfg.RUN_DIR, sess + '.paused');
function pausedFlag(sess) {
  try { return fs.existsSync(pausedFlagPath(sess)); } catch { return false; }
}

// another existing project whose tmux session would be the SAME one as `name`'s: validName accepts '.',
// sessionName turns it into '_' ("a.b" and "a_b" both -> claude-a_b), so two projects would share
// one terminal/Claude and every action on one would hit the other. -> the clashing name | ''
function sessionClash(name, except) {
  const sess = sessionName(name);
  return listProjects().find((p) => p !== name && p !== except && sessionName(p) === sess) || '';
}

// ---------- acoes ----------
async function createProject(name, autoStartClaude, autoRemote) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badNameHint') };
  const dir = path.join(cfg.PROJECTS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, msg: tr('srv.exists') };
  const clash = sessionClash(name);
  if (clash) return { ok: false, msg: tr('srv.sessionClash', { name: clash }) };
  fs.mkdirSync(dir, { recursive: true });
  await sh('git', ['-C', dir, 'init', '-q']);
  setProjConfig(name, { enabled: true, autoStartClaude: !!autoStartClaude, autoRemote: !!autoRemote });
  await ensureSession(name);
  events.poke();
  return { ok: true, msg: tr('srv.created', { name, claude: autoStartClaude ? 'ON' : 'OFF', remote: autoRemote ? 'ON' : 'OFF' }) };
}
// Restart = turns ON (if it was off) + kills the whole session + recreates it from scratch. The supervisor
// reopens Claude, sends remote-control again and sends the first line.
async function restartProject(name) {
  if (!projectExists(name)) return { ok: false, msg: tr('srv.noProject') };
  if (!projConfig(name).enabled && !setProjConfig(name, { enabled: true })) return { ok: false, msg: tr('srv.saveConfigFailed') };
  await recreateSession(name);
  events.poke();
  const c = projConfig(name);
  if (!c.autoStartClaude) return { ok: true, msg: tr('srv.restartedShell', { name }) };
  return { ok: true, msg: tr('srv.restarted', { name }) + (c.autoRemote ? tr('srv.restartedRemote') : '') + (c.initLine ? tr('srv.restartedInit') : '') };
}
// Turn the PROJECT on/off. Off = no tmux session, and it stays so at container boot
// and in the watchdog (the watchdog used to recreate everything in ~10s and "off" did not last).
async function setPower(name, on) {
  if (!projectExists(name)) return { ok: false, msg: tr('srv.noProject') };
  const val = truthy(on);
  if (val && require('./restore').restoring(name)) return { ok: false, msg: tr('srv.restore.busy') };
  if (!setProjConfig(name, { enabled: val })) return { ok: false, msg: tr('srv.saveConfigFailed') };
  if (val) await ensureSession(name);
  else await killSession(name);
  events.poke();
  return { ok: true, msg: val ? tr('srv.powerOn', { name }) : tr('srv.powerOff', { name }) };
}
// Claude keeps the history in ~/.claude/projects/<encoded cwd> (non-alphanumeric -> "-").
function migrateClaudeHistory(oldDir, newDir) {
  try {
    const base = path.join(cfg.CLAUDE_DIR, 'projects');
    const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    const from = path.join(base, enc(oldDir));
    const to = path.join(base, enc(newDir));
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); return true; }
  } catch (e) { log('error', 'migrate hist', { err: e.message }); }
  return false;
}
async function renameProject(oldName, newName) {
  if (!validName(oldName) || !validName(newName)) return { ok: false, msg: tr('srv.badName') };
  if (oldName === newName) return { ok: false, msg: tr('srv.sameName') };
  const oldDir = path.join(cfg.PROJECTS_DIR, oldName);
  const newDir = path.join(cfg.PROJECTS_DIR, newName);
  if (!fs.existsSync(oldDir)) return { ok: false, msg: tr('srv.noFolder') };
  if (fs.existsSync(newDir)) return { ok: false, msg: tr('srv.projectExists', { name: newName }) };
  const clash = sessionClash(newName, oldName);
  if (clash) return { ok: false, msg: tr('srv.sessionClash', { name: clash }) };
  await killSession(oldName);
  try { fs.renameSync(oldDir, newDir); }
  catch (e) { return { ok: false, msg: tr('srv.renameFailed') + e.message }; }
  const histMoved = migrateClaudeHistory(oldDir, newDir);
  const c = loadConfig();
  if (c.projects && c.projects[oldName]) {
    c.projects[newName] = c.projects[oldName];
    delete c.projects[oldName];
    saveConfig(c);
  }
  require('./chat').onRename(oldName, newName); // lazy: avoids a require cycle
  await ensureSession(newName);
  events.poke();
  return { ok: true, msg: `"${oldName}" -> "${newName}"` + (histMoved ? tr('srv.histMoved') : '') + tr('srv.sessionRecreated') };
}
async function deleteProject(name) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  const dir = path.join(cfg.PROJECTS_DIR, name);
  if (!fs.existsSync(dir)) return { ok: false, msg: tr('srv.noFolder') };
  // lock during kill + rm: without it the watchdog (every 10s) saw the folder still there and the session
  // dead and brought everything back in the middle of the deletion (bug of the "codigo" project, 2026-11-24)
  const lock = path.join(cfg.RUN_DIR, sessionName(name) + '.lock');
  try { fs.mkdirSync(cfg.RUN_DIR, { recursive: true }); fs.writeFileSync(lock, String(process.pid)); } catch { /* */ }
  try {
    await killSession(name);
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { return { ok: false, msg: tr('srv.deleteFailed') + e.message }; }
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch { /* */ }
  }
  const c = loadConfig();
  if (c.projects && c.projects[name]) { delete c.projects[name]; saveConfig(c); }
  require('./chat').onDelete(name); // chat link keys of the project are removed
  events.poke();
  return { ok: true, msg: tr('srv.deleted', { name }) };
}
async function sendRemote(name) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  const sess = sessionName(name);
  if (!(await sessionUp(sess))) return { ok: false, msg: tr('srv.tmuxDown') };
  if (!loginInfo(projConfig(name).account).logged) return { ok: false, msg: tr('srv.notLogged') };
  // without Claude running, the text would land in the session's bash (or in a vim)
  if (!claudeRunningFlag(sess)) return { ok: false, msg: tr('srv.claudeNotRunning') };
  const cmd = remoteCmdFor(name);
  await typeLine(sess, cmd);
  // Claude Code 2.1.28x+: asks for confirmation ("❯ 1. Enable Remote Control") -> Enter accepts
  // (Esc would be "Never mind"). Watches for up to ~8s.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const c = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-S', '-40']);
    if (c.ok && /❯\s*1\.\s*Enable Remote Control/.test(c.stdout)) { await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Enter']); break; }
    if (c.ok && /claude\.ai\/code\//.test(c.stdout)) break;
  }
  // older versions opened a dialog ("> Continue · Esc to continue") that blocks the prompt:
  // within ~10s, if it is on screen, sends Esc to go back to the prompt (the link stays valid)
  setTimeout(async () => {
    for (let i = 0; i < 5; i++) {
      const r = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-S', '-60']);
      if (!r.ok || !/Esc to continue|Disconnect this session|Show QR code/.test(r.stdout)) break;
      await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Escape']);
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    events.poke();
  }, 10000);
  events.poke();
  return { ok: true, msg: tr('srv.remoteResent', { cmd }) };
}
async function setConfig(name, key, value) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  if (key === 'enabled') return setPower(name, value);
  if (!FLAGS.includes(key)) return { ok: false, msg: tr('srv.badKey') };
  const val = truthy(value);
  if (!setProjConfig(name, { [key]: val })) return { ok: false, msg: tr('srv.saveConfigFailed') };
  events.poke();
  if (key === 'autoStartClaude') {
    // applies AT ONCE: ON starts Claude, OFF closes Claude and leaves only the shell in the folder
    const c = projConfig(name);
    if (!c.enabled) return { ok: true, msg: tr('srv.claudeWhenOn', { name, v: val ? 'ON' : 'OFF' }) };
    await recreateSession(name);
    events.poke();
    return { ok: true, msg: val ? tr('srv.claudeOn', { name }) : tr('srv.claudeOff', { name }) };
  }
  if (key === 'autoRemote') {
    if (val) {
      const r = await sendRemote(name);
      return {
        ok: true,
        msg: r.ok ? tr('srv.remoteOnSent', { name, cmd: remoteCmdFor(name) })
                  : tr('srv.remoteOnLater', { name }),
      };
    }
    return { ok: true, msg: tr('srv.remoteOff', { name }) };
  }
  return { ok: true };
}
async function setInitLine(name, text) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  const t = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').slice(0, 1000);
  if (!setProjConfig(name, { initLine: t })) return { ok: false, msg: tr('srv.saveConfigFailed') };
  events.poke();
  return { ok: true, msg: t ? `"${name}": primeira linha salva (vale no proximo inicio do Claude)` : `"${name}": primeira linha removida` };
}
// session mode: 'new' | 'continue' | 'pinned' (needs an id that exists in the project history)
async function setSessionMode(name, mode, id) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  if (!projectExists(name)) return { ok: false, msg: tr('srv.noProject') };
  if (!SESSION_MODES.has(mode)) return { ok: false, msg: tr('srv.badMode') };
  let pinnedSession = '';
  if (mode === 'pinned') {
    if (!PINNED_ID_RX.test(String(id || ''))) return { ok: false, msg: tr('srv.badConvId') };
    const h = await history.listHistory(name);
    if (!h.ok || !h.sessions.some((s) => s.id === id)) return { ok: false, msg: tr('srv.convNotInHistory') };
    pinnedSession = id;
  }
  if (!setProjConfig(name, { sessionMode: mode, pinnedSession: mode === 'pinned' ? pinnedSession : undefined })) {
    return { ok: false, msg: tr('srv.saveConfigFailed') };
  }
  events.poke();
  return { ok: true, msg: tr('srv.sessionMode', { name, mode }) + (mode === 'pinned' ? ` (${pinnedSession.slice(0, 8)}…)` : '') };
}
// Claude account of the project (chosen by hand, never switched automatically). Saving it restarts the
// session when the project is on — the running task is interrupted (the UI asks first); with
// sessionMode continue/pinned the same conversation comes back, now on the other account.
async function setAccount(name, account) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  if (!projectExists(name)) return { ok: false, msg: tr('srv.noProject') };
  const id = String(account || accounts.DEFAULT);
  if (!accounts.exists(id)) return { ok: false, msg: tr('srv.acct.none') };
  const c = projConfig(name);
  const label = accounts.labelOf(id);
  if (c.account === id) return { ok: true, msg: tr('srv.acct.same', { name, label }) };
  if (!setProjConfig(name, { account: accounts.isDefault(id) ? undefined : id })) return { ok: false, msg: tr('srv.saveConfigFailed') };
  if (c.enabled) await recreateSession(name);
  events.poke();
  return { ok: true, msg: tr(c.enabled ? 'srv.acct.switched' : 'srv.acct.switchedOff', { name, label }) };
}

// manual pause: always writes the flag; only sends /exit if Claude is idle at the prompt
// (does not interrupt work in progress) — claude-loop.sh does not reopen while the flag exists
async function pauseProject(name) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  if (!projectExists(name)) return { ok: false, msg: tr('srv.noProject') };
  const sess = sessionName(name);
  try {
    fs.mkdirSync(cfg.RUN_DIR, { recursive: true });
    fs.writeFileSync(pausedFlagPath(sess), 'manual');
  } catch (e) { return { ok: false, msg: tr('srv.flagFailed') + e.message }; }
  let exited = false;
  if (claudeRunningFlag(sess) && ['idle', 'prompt'].includes(events.activityOf(sess))) {
    await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', '/exit']);
    await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Enter']);
    exited = true;
  }
  events.poke();
  return { ok: true, msg: tr('srv.paused', { name }) + (exited ? tr('srv.pausedExit') : '') + tr('srv.pausedNote') };
}
function unpauseProject(name) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  if (!projectExists(name)) return { ok: false, msg: tr('srv.noProject') };
  const sess = sessionName(name);
  try { fs.rmSync(pausedFlagPath(sess), { force: true }); } catch (e) { return { ok: false, msg: e.message }; }
  events.poke();
  return { ok: true, msg: tr('srv.unpaused', { name }) };
}

// ---------- estado consolidado (dashboard) ----------
async function buildState() {
  const names = listProjects();
  const conf = loadConfig();
  const projects = await Promise.all(names.map(async (name) => {
    const sess = sessionName(name);
    const up = await sessionUp(sess);
    const c = configFrom(conf, name);
    return {
      name,
      dir: path.join(cfg.PROJECTS_DIR, name),
      session: sess,
      up,
      claudeRunning: up && claudeRunningFlag(sess),
      enabled: c.enabled,
      autoStartClaude: c.autoStartClaude,
      autoRemote: c.autoRemote,
      initLine: c.initLine,
      sessionMode: c.sessionMode,
      pinnedSession: c.pinnedSession,
      idlePauseHours: c.idlePauseHours,
      account: c.account,
      paused: pausedFlag(sess),
      autoResumeAt: (require('./autoresume').list().find((x) => x.project === name) || {}).at || 0,
      remoteCmd: remoteCmdFor(name),
      remoteUrl: up ? events.remoteUrlOf(sess) : '',
    };
  }));
  return {
    projectsDir: cfg.PROJECTS_DIR,
    panelVersion: cfg.PANEL_VERSION,
    buildTime: cfg.BUILD_TIME,
    login: loginInfo(),
    accounts: accounts.summary(),
    version: await claudeVersion(),
    remoteNameForced: cfg.REMOTE_CONTROL_NAME,
    shellSession: cfg.SHELL_SESSION,
    settings: conf.settings || {},
    projects,
  };
}

module.exports = {
  listProjects, projConfig, loadConfig, saveConfig, sessionUp, ensureSession, killSession, recreateSession,
  createProject, restartProject, renameProject, deleteProject, sendRemote, setConfig, setPower, setInitLine,
  setSessionMode, setAccount, pauseProject, unpauseProject, claudeRunningFlag, pausedFlag,
  buildState,
};
