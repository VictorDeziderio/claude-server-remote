'use strict';
/*
 * Push notifications: events -> policy (per-event toggles, dedupe, rate limit) -> push.js.
 *
 * Other modules call   notify({ event, project, title, body, url, key })   (event = one of
 * EVENTS below). Sources wired here:
 *
 *  - Claude Code HOOKS (primary, works with the panel closed): managed-settings.json runs
 *    devbox-hook.sh on Stop / StopFailure / Notification / UserPromptSubmit; the script appends
 *    one JSON line to RUN_DIR/hooks.jsonl, polled here every 2s (stat only when nothing changed).
 *    Hooks are exact (Claude itself says "turn finished" / "needs permission"), unlike reading
 *    the tmux screen, which only runs while a browser tab is open (events.js pauses without SSE
 *    clients) and guesses from text patterns.
 *      Stop               -> done      (skipped: `claude -p`/SDK runs, turns shorter than
 *                                       doneMinSeconds, turns waiting on background tasks)
 *      Notification       -> waiting   (permission_prompt / elicitation_dialog / idle_prompt;
 *                                       idle_prompt right after a "done" is the same news: skipped)
 *      StopFailure        -> login (authentication errors) | usage (rate_limit/billing) | done
 *      UserPromptSubmit   -> remembers when the turn started and whether it is interactive
 *  - tmux watcher (events.js 'notify' broadcasts): fallback for done/waiting only while no hook
 *    event was seen in the last 24h (image without the hook, older Claude Code).
 *  - alerts.jsonl (via the same broadcast): crash-loop of a project.
 *  - Claude login state (claude.loginInfo, every 60s): logged in -> logged out.
 *  - Boot: kernel boot id + start time of PID 1 changed since the last run = dev-box restarted
 *    (a panel respawn alone does not count).
 *  - limits.js onThreshold(cb): plan window / API spend crossed a threshold.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log, validName, clampInt } = require('./util');
const push = require('./push');

const EVENTS = {
  done: { label: 'Claude finished a task', gapMs: 2 * 60e3 },
  waiting: { label: 'Claude is waiting for you (permission, question or input)', gapMs: 2 * 60e3 },
  crash: { label: 'A project is in a crash-loop', gapMs: 10 * 60e3 },
  boot: { label: 'The dev-box restarted', gapMs: 0 },
  login: { label: 'Claude is logged out / needs login', gapMs: 30 * 60e3 },
  usage: { label: 'Usage is near the limit', gapMs: 6 * 3600e3 },
};
const RATE_MAX = 12, RATE_WINDOW_MS = 10 * 60e3;   // at most 12 pushes per 10 minutes, all events
const STALE_MS = 5 * 60e3;                          // hook lines older than this are ignored
const HOOK_FILE = path.join(cfg.RUN_DIR, 'hooks.jsonl');
const HOOK_ROTATE_BYTES = 512 * 1024;

const lastSent = new Map();   // dedupe key -> t
let sentTimes = [];           // for the global rate limit
let recent = [];              // last decisions (shown in the tab; useful to debug)
const turns = new Map();      // session id -> { start, src }
const lastDone = new Map();   // project -> t of the last "done"
let hooksSeenAt = 0;
let hookOffset = -1;
let timers = [];

// ---------- prefs ----------
const DEFAULT_PREFS = { events: Object.fromEntries(Object.keys(EVENTS).map((k) => [k, true])), doneMinSeconds: 20, usagePct: 80 };
function prefs() {
  const p = push.getPref('notify') || {};
  return { ...DEFAULT_PREFS, ...p, events: { ...DEFAULT_PREFS.events, ...(p.events || {}) } };
}
function setPrefs(b = {}) {
  const p = prefs();
  if (b.events && typeof b.events === 'object') for (const k of Object.keys(EVENTS)) if (k in b.events) p.events[k] = !!b.events[k];
  if ('doneMinSeconds' in b) p.doneMinSeconds = clampInt(b.doneMinSeconds, 0, 3600, DEFAULT_PREFS.doneMinSeconds);
  if ('usagePct' in b) p.usagePct = clampInt(b.usagePct, 50, 100, DEFAULT_PREFS.usagePct);
  return push.setPref('notify', p) ? { ok: true, msg: 'notification preferences saved', prefs: p } : { ok: false, msg: 'could not save' };
}

// ---------- the API other modules call ----------
const urlFor = (project) => (project ? '/terminal/' + encodeURIComponent(project) : '/dashboard');
function remember(entry) { recent.unshift(entry); if (recent.length > 30) recent.length = 30; }

async function notify(ev = {}) {
  const now = Date.now();
  const def = EVENTS[ev.event];
  const project = ev.project && validName(ev.project) ? ev.project : '';
  const entry = { t: now, event: ev.event, project, title: String(ev.title || '').slice(0, 120) };
  const skip = (why) => { entry.skipped = why; remember(entry); return { ok: true, sent: 0, skipped: why }; };
  if (!def) return { ok: false, msg: 'unknown event' };
  if (!prefs().events[ev.event]) return skip('disabled');
  const key = ev.event + ':' + (ev.key || project);
  if (def.gapMs && now - (lastSent.get(key) || 0) < def.gapMs) return skip('duplicate');
  sentTimes = sentTimes.filter((t) => now - t < RATE_WINDOW_MS);
  if (sentTimes.length >= RATE_MAX) return skip('rate limit');
  if (!push.devices().length) return skip('no devices');
  lastSent.set(key, now); sentTimes.push(now);
  const payload = {
    title: entry.title || 'Claude Remote', body: String(ev.body || '').slice(0, 240),
    url: typeof ev.url === 'string' && ev.url.startsWith('/') ? ev.url : urlFor(project),
    tag: 'cr-' + ev.event + (project ? '-' + project : ''), event: ev.event, project, t: now,
  };
  const r = await push.sendAll(payload, { topic: payload.tag, urgency: ev.event === 'waiting' || ev.event === 'crash' ? 'high' : 'normal' });
  entry.sent = r.sent; entry.failed = r.failed;
  remember(entry);
  return { ok: true, sent: r.sent, failed: r.failed };
}

// ---------- hooks (devbox-hook.sh -> RUN_DIR/hooks.jsonl) ----------
function projectOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const rel = path.relative(cfg.PROJECTS_DIR, cwd);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  const first = rel.split(path.sep)[0];
  return validName(first) ? first : '';
}
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const AUTH_ERR = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error']);
const LIMIT_ERR = new Set(['rate_limit', 'billing_error']);

function handleHook(h, now = Date.now()) {
  if (!h || typeof h !== 'object' || typeof h.ev !== 'string') return null;
  if (typeof h.t === 'number' && now - h.t > STALE_MS) return null;
  hooksSeenAt = now;
  const t = typeof h.t === 'number' ? h.t : now;
  const project = projectOf(h.cwd);
  const name = project || 'shell';
  const sid = String(h.sid || '');
  if (h.agent) return null; // subagent: the main thread reports for it
  if (h.ev === 'UserPromptSubmit') {
    if (sid) turns.set(sid, { start: t, src: String(h.src || '') });
    if (turns.size > 200) turns.delete(turns.keys().next().value);
    return null;
  }
  const turn = turns.get(sid);
  // `claude -p` / Agent SDK runs (scripts, a Claude calling another Claude) are not "your" sessions
  const nonInteractive = (turn && turn.src === 'sdk') || (h.tty === 0 && !(turn && turn.src === 'user'));
  if (h.ev === 'Stop' || h.ev === 'StopFailure') {
    turns.delete(sid);
    if (nonInteractive) return null;
    const err = String(h.err || '');
    if (h.ev === 'StopFailure' && AUTH_ERR.has(err)) {
      return { event: 'login', project, url: '/account', title: 'Claude needs login', body: `${name}: ${clip(h.msg || err.replace(/_/g, ' '), 160)}` };
    }
    if (h.ev === 'StopFailure' && LIMIT_ERR.has(err)) {
      return { event: 'usage', project, key: 'limit', url: urlFor(project), title: 'Claude usage limit reached', body: `${name}: ${clip(h.msg || err.replace(/_/g, ' '), 160)}` };
    }
    if (h.ev === 'Stop' && h.bg > 0) return null; // waiting on background work: not finished yet
    const secs = turn ? Math.round((t - turn.start) / 1000) : null;
    if (h.ev === 'Stop' && secs != null && secs < prefs().doneMinSeconds) return null;
    lastDone.set(project, t);
    if (h.ev === 'StopFailure') return { event: 'done', project, title: `Claude stopped with an error — ${name}`, body: clip(h.msg || err.replace(/_/g, ' '), 200) };
    return { event: 'done', project, title: `Claude finished — ${name}`, body: clip(h.msg, 200) || (secs != null ? `Worked for ${secs}s. Ready for your next instruction.` : 'Ready for your next instruction.') };
  }
  if (h.ev === 'Notification') {
    if (nonInteractive) return null;
    const type = String(h.type || '');
    if (type === 'auth_success') return null;
    const idle = type === 'idle_prompt' || (!type && /waiting for your input/i.test(h.msg || ''));
    if (idle && t - (lastDone.get(project) || 0) < 10 * 60e3) return null; // already told "finished"
    const what = type === 'permission_prompt' ? 'needs your permission' : type === 'elicitation_dialog' ? 'has a question for you' : idle ? 'is waiting for your input' : 'needs your attention';
    return { event: 'waiting', project, key: project + ':' + (idle ? 'idle' : type || 'other'), title: `Claude ${what} — ${name}`, body: clip(h.msg, 200) };
  }
  return null;
}

function readHookLines() {
  let st;
  try { st = fs.statSync(HOOK_FILE); } catch { hookOffset = 0; return []; }
  if (hookOffset < 0) { hookOffset = st.size; return []; } // panel (re)start: never replay old lines
  if (st.size < hookOffset) hookOffset = 0;
  if (st.size === hookOffset) return [];
  let buf;
  try {
    const fd = fs.openSync(HOOK_FILE, 'r');
    try { buf = Buffer.alloc(st.size - hookOffset); fs.readSync(fd, buf, 0, buf.length, hookOffset); } finally { fs.closeSync(fd); }
  } catch (e) { log('error', 'notify: hooks read', { err: e.message }); return []; }
  const nl = buf.lastIndexOf(0x0a);
  if (nl === -1) return [];
  hookOffset += nl + 1;
  const out = [];
  for (const line of buf.subarray(0, nl + 1).toString('utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* broken line */ }
  }
  // keep the file small without losing lines: every hook run opens the file anew with >>, so
  // after a rename the next write creates a fresh file (nothing is truncated under a writer)
  if (hookOffset >= HOOK_ROTATE_BYTES && hookOffset === st.size) {
    try { fs.renameSync(HOOK_FILE, HOOK_FILE + '.old'); hookOffset = 0; } catch { /* */ }
  }
  return out;
}
async function pollHooks() {
  for (const h of readHookLines()) {
    const ev = handleHook(h);
    if (ev) await notify(ev).catch((e) => log('error', 'notify', { err: e.message }));
  }
}

// ---------- tmux watcher + alerts (events.js broadcast 'notify') ----------
function onPanelNotify(n) {
  if (!n || typeof n !== 'object') return;
  if (n.kind === 'alert') {
    if (n.alertKind === 'crash-loop') notify({ event: 'crash', project: n.project, title: `Crash-loop — ${n.project || 'dev-box'}`, body: n.body || 'Claude keeps exiting; the supervisor stopped restarting it.' }).catch(() => {});
    return;
  }
  if (Date.now() - hooksSeenAt < 24 * 3600e3) return; // hooks are active: they are exact
  if (n.kind === 'done') notify({ event: 'done', project: n.name, title: `Claude finished — ${n.name}`, body: 'Ready for your next instruction.' }).catch(() => {});
  else if (n.kind === 'prompt') notify({ event: 'waiting', project: n.name, title: `Claude is waiting for you — ${n.name}`, body: 'A question or permission is pending in the terminal.' }).catch(() => {});
}

// ---------- login ----------
let wasLogged = null;
function checkLogin() {
  let logged = true;
  try { logged = !!require('./claude').loginInfo().logged; } catch { return; }
  if (wasLogged !== false && !logged) notify({ event: 'login', url: '/account', title: 'Claude is logged out', body: 'Sessions cannot run until you log in again (Account page).' }).catch(() => {});
  wasLogged = logged;
}

// ---------- boot ----------
function bootId() {
  if (process.env.PANEL_BOOT_ID) return process.env.PANEL_BOOT_ID;
  let host = '', pid1 = '';
  try { host = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { /* not linux */ }
  try { pid1 = fs.readFileSync('/proc/1/stat', 'utf8').split(') ')[1].split(' ')[19]; } catch { /* */ }
  return host || pid1 ? host + ':' + pid1 : '';
}
function checkBoot() {
  const id = bootId();
  if (!id) return;
  const prev = push.getMeta('lastBoot');
  if (prev === id) return;
  push.setMeta('lastBoot', id);
  if (!prev) return; // first run ever: nothing restarted
  const hostRebooted = prev.split(':')[0] !== id.split(':')[0];
  notify({ event: 'boot', title: hostRebooted ? 'Server rebooted' : 'Dev-box restarted', body: 'The panel is back online. Projects marked "on" are starting again.' }).catch(() => {});
}

// ---------- usage (server/limits.js: plan windows + API spend) ----------
// limits.js fires once per (window, reset period, threshold level); here we only apply the
// user's minimum % from the notification prefs.
function onThreshold(ev) {
  if (!ev || !Number.isFinite(Number(ev.percent))) return;
  if (Number(ev.percent) < prefs().usagePct) return;
  const pct = Math.round(Number(ev.percent));
  const label = String(ev.label || ev.id || 'usage').slice(0, 40);
  notify({ event: 'usage', key: `${ev.source}:${ev.id}:${ev.threshold}:${ev.resetsAt || ''}`, url: '/',
    title: `Claude usage at ${pct}% (${label})`, body: ev.resetsAt ? `Resets ${new Date(ev.resetsAt).toLocaleString()}.` : 'Close to the limit.' }).catch(() => {});
}
function hookUsage() {
  try { require('./limits').onThreshold(onThreshold); return true; } catch (e) { log('error', 'notify: limits hook', { err: e.message }); }
  return false;
}

// ---------- lifecycle + routes ----------
function start() {
  if (timers.length) return;
  try { require('./events').onNotify(onPanelNotify); } catch { /* events.js without onNotify */ }
  hookUsage();
  readHookLines(); // sets the offset at the end of the file
  checkBoot();
  checkLogin();
  timers.push(setInterval(() => { pollHooks().catch(() => {}); }, 2000));
  timers.push(setInterval(checkLogin, 60000));
  for (const t of timers) t.unref();
}
function stop() { for (const t of timers) clearInterval(t); timers = []; }

const info = () => ({
  ok: true, supported: push.supported(), publicKey: push.publicKey(), devices: push.devices(), prefs: prefs(),
  events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, v.label])),
  hooksSeenAt, recent: recent.slice(0, 20),
});
const hostOf = (req) => String((req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].trim();
const routes = {
  GET: { '/api/push/info': async () => info() },
  POST: {
    '/api/push/subscribe': (b, req) => push.subscribe(b.subscription, { name: b.name, host: hostOf(req), replaces: b.replaces }),
    '/api/push/unsubscribe': (b) => push.unsubscribe({ id: b.id, endpoint: b.endpoint }),
    '/api/push/prefs': (b) => setPrefs(b),
    '/api/push/test': async (b) => {
      const r = await push.sendAll({ title: 'Claude Remote — test', body: 'Notifications are working on this device.', url: '/notifications', tag: 'cr-test', event: 'test', t: Date.now() }, { id: b.id || '', TTL: 120, topic: 'cr-test' });
      remember({ t: Date.now(), event: 'test', project: '', title: 'test', sent: r.sent, failed: r.failed });
      return r;
    },
  },
  AUDITED: ['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/prefs', '/api/push/test'],
};

module.exports = { notify, start, stop, routes, EVENTS, handleHook, projectOf, onThreshold, prefs, setPrefs };
