'use strict';
// Claude Code updates: the "Update" button (now) and the automatic update (every few hours).
//
// Claude's own updater cannot work here: the CLI is installed globally by root in the image and
// runs as the panel user, so the image sets DISABLE_AUTOUPDATER=1 and this module does it instead,
// through `sudo -n npm install -g` (NOPASSWD in the Dockerfile).
//   - auto: a check CHECK_HOURS after the previous one (first one a few minutes after boot); when npm
//     has a newer version and the switch is on (Settings, and env CLAUDE_AUTO_UPDATE != 0) it installs it.
//   - every install is checked: `claude --version` must print the new version (since 2.1.28x the CLI
//     is a native binary in an optional dependency, and npm "succeeds" when that download fails).
//     On failure the previous version is installed back, so Claude never stays broken.
//   - running sessions keep the version they started with; new sessions and restarts get the new one.
const { tr } = require('./i18n');
const { sh, log } = require('./util');

const PKG = '@anthropic-ai/claude-code';
const S = {
  firstCheckMs: 5 * 60e3,
  everyMs: (Number(process.env.CLAUDE_UPDATE_HOURS) || 6) * 3600e3,
};
const D = {
  now: () => Date.now(),
  current: async () => { const c = require('./claude'); c.resetVersionCache(); return numOf(await c.claudeVersion()); },
  latest: () => require('./health').latestClaude(true),
  install: (v) => sh('sudo', ['-n', 'npm', 'install', '-g', '--include=optional', `${PKG}@${v}`], { timeout: 5 * 60e3 }),
  enabled: () => process.env.CLAUDE_AUTO_UPDATE !== '0' && require('./settings').getSettings().settings.autoUpdateClaude !== false,
  notify: (title, body) => require('./notify').notify({ event: 'update', title, body }).catch(() => {}),
};

const numOf = (v) => (String(v || '').match(/\d+\.\d+\.\d+/) || [''])[0];
// a > b for x.y.z versions
function newer(a, b) {
  const pa = numOf(a).split('.').map(Number), pb = numOf(b).split('.').map(Number);
  if (pa.length < 3 || pb.length < 3) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

let running = null;
let last = null;      // { at, auto, ok, from, to, msg }
let nextAt = 0;
let timer = null;

// installs `target` and checks that it really runs; rolls back to `from` when it does not
async function installChecked(target, from) {
  let r = null;
  for (let i = 0; i < 2; i++) {
    r = await D.install(target);
    if (r.ok && (await D.current()) === target) return { ok: true, output: r.stdout + r.stderr };
  }
  const why = r && r.ok ? tr('srv.npmNoBinary') : tr('srv.updateFailed') + String((r && r.stderr) || '').slice(-300);
  if (from) await D.install(from);
  const now = await D.current();
  return { ok: false, msg: from && now === from ? tr('srv.update.rolledBack', { why, v: from }) : why, output: r ? r.stdout + r.stderr : '' };
}

async function run(auto) {
  if (running) return auto ? null : { ok: false, msg: tr('srv.updateRunning') };
  running = (async () => {
    const from = await D.current();
    const to = numOf(await D.latest());
    if (!to) return { ok: false, msg: tr('srv.update.noLatest') };
    if (!newer(to, from)) return { ok: true, msg: tr('srv.update.upToDate', { v: from }), current: from };
    log('info', 'claude update', { from, to, auto });
    const r = await installChecked(to, from);
    last = { at: D.now(), auto, ok: r.ok, from, to, msg: r.ok ? '' : r.msg };
    if (r.ok) {
      if (auto) D.notify(tr('srv.update.autoTitle', { v: to }), tr('srv.update.autoBody', { from }));
      return { ok: true, msg: tr('srv.updated', { v: to }), current: to, output: (r.output || '').slice(-2000) };
    }
    log('error', 'claude update failed', { from, to });
    if (auto) D.notify(tr('srv.update.failedTitle'), r.msg);
    return { ok: false, msg: r.msg, output: (r.output || '').slice(-2000) };
  })();
  try { return await running; } finally { running = null; }
}

// "Update" button
const updateNow = () => run(false);

// one automatic check (also called by the timer)
async function tick() {
  nextAt = D.now() + S.everyMs;
  if (!D.enabled()) return null;
  return run(true);
}

function start() {
  if (timer) return;
  nextAt = D.now() + S.firstCheckMs;
  const loop = (ms) => { timer = setTimeout(async () => { await tick().catch((e) => log('error', 'claude auto-update', { err: e.message })); loop(S.everyMs); }, ms); timer.unref(); };
  loop(S.firstCheckMs);
}
function stop() { clearTimeout(timer); timer = null; }

const status = () => ({ enabled: D.enabled(), nextAt: D.enabled() ? nextAt : 0, last, running: !!running });

module.exports = { updateNow, tick, start, stop, status, newer, _deps: D, _settings: S, _reset: () => { last = null; running = null; nextAt = 0; } };
