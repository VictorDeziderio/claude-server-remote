'use strict';
const { tr } = require('./i18n');
/*
 * Real time: watcher + SSE (/api/events).
 *
 * Every WATCH_INTERVAL_MS the watcher looks at each project session (tmux capture-pane of the
 * last 300 lines) and keeps:
 *   - activity: 'busy' (screen changing) | 'idle' (still) | 'prompt' (Claude waiting for an
 *     answer from you: permission/confirmation) | 'off' (session/Claude stopped)
 *   - remoteUrl (most recent claude.ai/code/... link on screen)
 * Transitions busy->idle (after >=5s busy) and ->prompt produce NOTIFICATIONS.
 * The consolidated state (buildState) is recomputed on each tick and sent over SSE only when
 * it changes (hash), so the client needs no polling.
 *
 * SSE events: state {…}, activity {name,state,since}, notify {title,body,name,kind}, ping.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { sh, sessionName, paneOf, log } = require('./util');
const { listProjects } = require('./projects-list');

const clients = new Set();           // res of each connected EventSource
// found by @security: with no limit, a panel session (sid) reconnecting in a loop (client bug
// or on purpose) piled up open EventSources forever — each with its own heartbeat/broadcast.
const MAX_SSE_PER_SID = 5;
const sidCounts = new Map();         // sid -> EventSource abertos agora
const act = new Map();               // sess -> { hash, changedAt, busySince, state, remoteUrl, lastLines }
let lastStateHash = '';
let lastState = null;
let stateBuilder = null;             // injetado por projects.js (evita ciclo)
let timer = null;
let ticking = false;

// patterns on screen that mean "Claude waiting for YOU" (permission/confirmation/choice)
// (the /remote-control dialog — "Esc to continue" — does NOT count: the loop/panel close it by themselves)
const PROMPT_RX = /(Do you want to (proceed|allow|make this edit|run|create|continue)|Allow (this|the) |Yes, (and )?(don't|allow|proceed)|^\s*(❯\s*)?1\.\s*Yes\b|\(y\/n\)|\[Y\/n\]|Would you like to|permission to|Waiting for (your )?(input|approval))/im;
const REMOTE_RX = /https:\/\/claude\.ai\/code\/[^\s'"()\]]+/g;

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* cliente sumiu */ }
}
// 'notify' also goes to in-process listeners (notify.js -> Web Push), with or without SSE clients
const notifyListeners = [];
const onNotify = (cb) => { if (typeof cb === 'function') notifyListeners.push(cb); };
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
  if (event === 'notify') for (const cb of notifyListeners) { try { cb(data); } catch (e) { log('error', 'notify listener', { err: e.message }); } }
}

function attach(req, res, sid) {
  if (sid) {
    const n = sidCounts.get(sid) || 0;
    if (n >= MAX_SSE_PER_SID) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(tr('srv.tooManyEvents'));
    }
    sidCounts.set(sid, n + 1);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  clients.add(res);
  if (lastState) send(res, 'state', lastState);
  send(res, 'activity', activitySnapshot());
  poke(); // the watcher pauses with no clients: refreshes state/activity right on reconnect
  const hb = setInterval(() => send(res, 'ping', { t: Date.now() }), 20000);
  req.on('close', () => {
    clearInterval(hb); clients.delete(res);
    if (sid) { const n = (sidCounts.get(sid) || 1) - 1; if (n <= 0) sidCounts.delete(sid); else sidCounts.set(sid, n); }
  });
}

const activitySnapshot = () => {
  const out = {};
  for (const [sess, a] of act) out[sess] = { state: a.state, since: a.changedAt, busySince: a.busySince || 0, remoteUrl: a.remoteUrl || '' };
  return out;
};
const activityOf = (sess) => (act.get(sess) || {}).state || 'off';
const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex');

// pause for inactivity: writes the flag that claude-loop.sh respects and sends /exit (Ctrl-C is
// NOT used here — /exit closes the conversation cleanly). Called when idle/prompt lasts
// >= idlePauseHours (per-project config) — see the end of tickSession.
async function autoPauseSession(name, sess) {
  try {
    fs.mkdirSync(cfg.RUN_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.RUN_DIR, sess + '.paused'), 'idle');
    await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', '/exit']);
    await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Enter']);
    log('info', 'projeto pausado por inatividade', { name, sess });
    poke();
  } catch (e) { log('error', 'auto-pause', { err: e.message }); }
}

async function tickSession(name, running, idlePauseHours) {
  const sess = sessionName(name);
  const a = act.get(sess) || { hash: '', changedAt: Date.now(), busySince: 0, state: 'off', remoteUrl: '', quietTicks: 0, autoPaused: false };
  act.set(sess, a);
  const prevState = a.state;
  if (!running) {
    a.state = 'off'; a.busySince = 0; a.autoPaused = false;
    if (prevState !== 'off') { a.changedAt = Date.now(); broadcast('activity', { name, session: sess, state: 'off', since: a.changedAt, busySince: 0, remoteUrl: a.remoteUrl || '' }); }
    return;
  }
  // -J: joins lines wrapped by the width (the remote link comes out whole)
  const r = await sh('tmux', ['capture-pane', '-t', '=' + sess + ':', '-p', '-J', '-S', '-300']);
  if (!r.ok) return;
  const screen = r.stdout || '';
  const m = screen.match(REMOTE_RX);
  if (m) a.remoteUrl = m[m.length - 1];
  const tail = screen.split('\n').slice(-60).join('\n');
  const h = hashOf(tail);
  const now = Date.now();
  let next;
  if (h !== a.hash) {
    a.hash = h; a.quietTicks = 0;
    if (!a.busySince) a.busySince = now;
    next = 'busy';
  } else {
    a.quietTicks++;
    // still for >= 2 ticks (~4s): idle or prompt (if the screen asks for something); before that keeps the state
    if (a.quietTicks >= 2) next = PROMPT_RX.test(tail) ? 'prompt' : 'idle';
    else next = a.state === 'off' ? 'idle' : a.state;
  }
  if (next !== prevState) {
    const busyFor = a.busySince ? now - a.busySince : 0;
    a.state = next; a.changedAt = now; a.autoPaused = false; // any transition restarts the inactivity clock
    // sends busySince/remoteUrl along (found by @qa 2026-09-28): the client reducer
    // (useEvents.js) merges, but the payload must carry the right value — 0 when
    // leaving 'busy' (the reset of a.busySince below only happens AFTER this broadcast)
    broadcast('activity', { name, session: sess, state: next, since: now, busySince: next === 'busy' ? a.busySince : 0, remoteUrl: a.remoteUrl || '' });
    if (next === 'prompt') {
      broadcast('notify', { kind: 'prompt', name, title: tr('srv.waitingTitle', { name }), body: tr('srv.waitingBody'), i18n: { title: ['srv.waitingTitle', { name }], body: ['srv.waitingBody'] } });
    } else if (next === 'idle' && prevState === 'busy' && busyFor >= 5000) {
      const secs = Math.round(busyFor / 1000);
      broadcast('notify', { kind: 'done', name, title: tr('srv.doneTitle', { name }), body: tr('srv.doneBody', { s: secs }), i18n: { title: ['srv.doneTitle', { name }], body: ['srv.doneBody', { s: secs }] } });
    }
    if (next !== 'busy') a.busySince = 0;
  }
  // automatic pause: idle/prompt (not busy) for >= idlePauseHours WITHOUT interruption — fires only once
  // per idle period (a.autoPaused), which is restarted by any state transition above
  if (idlePauseHours > 0 && !a.autoPaused && (a.state === 'idle' || a.state === 'prompt') && (now - a.changedAt) >= idlePauseHours * 3600 * 1000) {
    a.autoPaused = true;
    autoPauseSession(name, sess);
  }
}

// full state: projects + activity/remoteUrl from the watcher (tmux capture of each session)
async function buildFullState() {
  const state = stateBuilder ? await stateBuilder() : null;
  if (!state) return null;
  await Promise.all(state.projects.map((p) => tickSession(p.name, p.up && p.claudeRunning, p.idlePauseHours)));
  for (const p of state.projects) {
    const a = act.get(p.session);
    p.activity = a ? a.state : 'off';
    p.activitySince = a ? a.changedAt : 0;
    if (a && a.remoteUrl && p.up) p.remoteUrl = a.remoteUrl;
  }
  // drops sessions of projects that are gone
  const names = new Set(state.projects.map((p) => p.session));
  for (const k of act.keys()) if (!names.has(k)) act.delete(k);
  return state;
}

async function tick() {
  if (ticking) return;
  // found by @perf 2026-10-09: with the panel closed (no EventSource connected) there is no need
  // to capture tmux on each tick — nobody will see the broadcast. But the frozen lastState
  // would get stale (GET /api/state and the first SSE event serve it): discards it, currentState()
  // builds a full one on demand and attach() forces a tick on reconnect.
  if (clients.size === 0) { lastState = null; lastStateHash = ''; return; }
  ticking = true;
  try {
    const state = await buildFullState();
    if (state) {
      lastState = state;
      const h = hashOf(JSON.stringify(state));
      if (h !== lastStateHash) { lastStateHash = h; broadcast('state', state); }
    }
  } catch (e) { log('error', 'watcher', { err: e.message }); }
  finally { ticking = false; }
}

// found by @perf: with RUN_DIR/lowmem present (shell-side memory guard), the watcher goes
// from WATCH_INTERVAL_MS (2s) to 10s — less capture-pane/CPU while memory is tight.
const lowMemFlag = () => { try { return fs.existsSync(path.join(cfg.RUN_DIR, 'lowmem')); } catch { return false; } };
function scheduleTick() {
  const ms = lowMemFlag() ? 10000 : cfg.WATCH_INTERVAL_MS;
  timer = setTimeout(() => { tick().finally(scheduleTick); }, ms);
  timer.unref();
}
function start(builder) {
  stateBuilder = builder;
  if (timer) return;
  tick().finally(scheduleTick);
}
// forces a tick now (after an action) so SSE reflects it at once
const poke = () => { setTimeout(tick, 150); };
const remoteUrlOf = (sess) => (act.get(sess) || {}).remoteUrl || '';
const currentState = async () => lastState || buildFullState();
function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const res of clients) { try { res.end(); } catch { /* */ } }
  clients.clear();
}

// screen state NOW, without depending on the watcher (which only captures with a browser connected): two
// captures 2.5s apart, with the same rule as the tick: changed = 'busy'; still and asking for
// something (PROMPT_RX) = 'prompt'; still = 'idle'; no session = 'off'
async function probeActivity(sess) {
  const cap = async () => { const r = await sh('tmux', ['capture-pane', '-t', '=' + sess + ':', '-p', '-J', '-S', '-300']); return r.ok ? (r.stdout || '').split('\n').slice(-60).join('\n') : null; };
  const a = await cap();
  if (a == null) return 'off';
  await new Promise((r) => setTimeout(r, 2500));
  const b = await cap();
  if (b == null) return 'off';
  if (a !== b) return 'busy';
  return PROMPT_RX.test(b) ? 'prompt' : 'idle';
}

module.exports = { attach, broadcast, onNotify, start, stop, poke, remoteUrlOf, currentState, activitySnapshot, activityOf, probeActivity, clientCount: () => clients.size };
