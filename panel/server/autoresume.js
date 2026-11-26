'use strict';
// Auto-resume after a usage limit.
//
// When Claude stops because the plan limit was hit (hook StopFailure with err=rate_limit), the
// project is remembered here (RUN_DIR/autoresume.json, so a panel restart keeps it). At the reset
// time — the latest `resetsAt` of the plan windows at 100% (server/limits.js), plus a margin — the
// panel types the resume text ("continue" by default) into that project's tmux session.
//
// It only types when it is safe:
//   - the feature is on (settings.autoResume, default on; AUTO_RESUME=0 turns it off);
//   - the session is up, Claude is running in it, the project is not paused;
//   - the screen is 'idle' (not busy, not a permission/question dialog);
//   - nobody typed anything since the limit (a UserPromptSubmit that is not ours cancels it).
// If the limit is hit again, the next StopFailure schedules a new try. After MAX_TRIES sends or
// GIVE_UP_MS since the first hit, it gives up (until the person types or a turn ends). A finished
// turn (Stop) clears the entry.
//
// Also after a RESTART (deploy, container restart): the hooks tell when a turn starts
// (UserPromptSubmit) and ends (Stop/StopFailure). The projects with a turn in progress are kept
// on disk (RUN_DIR/autoresume-turns.json). When the panel starts again, each of them whose
// session reopens the same conversation (sessionMode continue/pinned; 'new' starts from zero, so
// there is nothing to continue) gets an entry with why='restart', due after RESTART_DELAY: the
// same safe-typing rules apply (Claude running, screen idle, nobody typed). If only the panel
// process restarted and Claude is still working, its Stop hook clears the entry.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sessionName, typeLine, log } = require('./util');

const FILE = path.join(cfg.RUN_DIR, 'autoresume.json');
const TURNS_FILE = path.join(cfg.RUN_DIR, 'autoresume-turns.json');
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const S = {
  marginMs: num(process.env.AUTO_RESUME_MARGIN_SECONDS, 90) * 1000,      // after resetsAt
  fallbackMs: num(process.env.AUTO_RESUME_FALLBACK_SECONDS, 1800) * 1000, // reset time unknown
  tickMs: num(process.env.AUTO_RESUME_TICK_SECONDS, 15) * 1000,
  ownPromptMs: 120e3,          // a UserPromptSubmit this soon after our send is our own text
  maxTries: num(process.env.AUTO_RESUME_MAX_TRIES, 6),
  giveUpMs: 8 * 86400e3,       // the weekly window can take days
  text: String(process.env.AUTO_RESUME_TEXT || 'continue').slice(0, 200),
  restartDelayMs: num(process.env.AUTO_RESUME_RESTART_SECONDS, 45) * 1000, // after the panel starts
  turnMaxMs: 12 * 3600e3,      // a "turn in progress" older than this is stale (lost Stop hook)
};

// dependencies (replaced in the unit test)
const D = {
  now: () => Date.now(),
  enabled: () => {
    if (/^(0|false|no|off)$/i.test(String(process.env.AUTO_RESUME || ''))) return false;
    try { const s = require('./projects').loadConfig().settings || {}; return s.autoResume !== false; } catch { return true; }
  },
  limits: () => { try { return require('./limits').snapshot(); } catch { return null; } },
  refreshLimits: async () => { try { await require('./limits').refresh(); } catch { /* */ } },
  sessionUp: async (sess) => { try { return await require('./projects').sessionUp(sess); } catch { return false; } },
  running: (sess) => require('./projects').claudeRunningFlag(sess),
  paused: (sess) => require('./projects').pausedFlag(sess),
  activity: (sess) => require('./events').probeActivity(sess),
  type: (sess, text) => typeLine(sess, text),
  notify: (ev) => { try { require('./notify').notify(ev).catch(() => {}); } catch { /* */ } },
  save: (obj) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(obj)); } catch (e) { log('error', 'autoresume: save', { err: e.message }); } },
  load: () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } },
  saveTurns: (obj) => { try { fs.mkdirSync(path.dirname(TURNS_FILE), { recursive: true }); fs.writeFileSync(TURNS_FILE, JSON.stringify(obj)); } catch (e) { log('error', 'autoresume: save turns', { err: e.message }); } },
  loadTurns: () => { try { return JSON.parse(fs.readFileSync(TURNS_FILE, 'utf8')) || {}; } catch { return {}; } },
  sessionMode: (project) => { try { return require('./projects').projConfig(project).sessionMode; } catch { return 'new'; } },
  account: (project) => { try { return require('./projects').projConfig(project).account || 'default'; } catch { return 'default'; } },
};

// plan windows of the Claude account the project uses (server/accounts.js): the default account is
// `claude` in the limits snapshot, the others are in `accounts[<id>]`
function windowsOf(snap, project) {
  const acct = project ? D.account(project) : 'default';
  const c = !snap ? null : acct === 'default' ? snap.claude : (snap.accounts || {})[acct];
  return c && Array.isArray(c.windows) ? c.windows : [];
}

let pending = {}; // project -> { since, at, tries, sentAt, why }
let turns = {};   // project -> start time of the turn in progress (from the hooks)
let timer = null;
let busy = false;

const save = () => D.save(pending);

// When does the limit end (for the account of `project`)? The latest reset among the plan windows at 100% (all of them must
// be free). None at 100% (the hit came from another window, or the poller is off): the earliest
// future reset among windows >= 90%; otherwise a fixed fallback.
function resumeAt(now = D.now(), project = '') {
  const wins = windowsOf(D.limits(), project)
    .map((w) => ({ p: Number(w.percent), r: Date.parse(w.resetsAt || '') }))
    .filter((w) => Number.isFinite(w.p) && Number.isFinite(w.r) && w.r > now);
  const full = wins.filter((w) => w.p >= 100).map((w) => w.r);
  if (full.length) return { at: Math.max(...full) + S.marginMs, why: 'reset' };
  const near = wins.filter((w) => w.p >= 90).map((w) => w.r);
  if (near.length) return { at: Math.min(...near) + S.marginMs, why: 'reset' };
  return { at: now + S.fallbackMs, why: 'fallback' };
}

// hook lines (called by notify.js for every interactive main-thread hook of a project)
function onHook(h, project, t = D.now()) {
  if (!project || !h) return null;
  if (h.ev === 'UserPromptSubmit' && turns[project] !== t) { turns[project] = t; D.saveTurns(turns); }
  if ((h.ev === 'Stop' || h.ev === 'StopFailure') && project in turns) { delete turns[project]; D.saveTurns(turns); }
  const p = pending[project];
  if (h.ev === 'StopFailure' && h.err === 'rate_limit') {
    if (!D.enabled()) return null;
    const { at, why } = resumeAt(t, project);
    if (p && p.gaveUp) return null; // stays given up until the person types or a turn ends well
    pending[project] = { since: p ? p.since : t, at, why, tries: p ? p.tries : 0, sentAt: 0 };
    save();
    return pending[project];
  }
  if (!p) return null;
  if (h.ev === 'UserPromptSubmit') {
    if (p.sentAt && t - p.sentAt < S.ownPromptMs) return null; // our own "continue"
    delete pending[project]; save(); // the person took over
    return null;
  }
  if (h.ev === 'Stop' || h.ev === 'StopFailure') { delete pending[project]; save(); } // turn ended for another reason
  return null;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = D.now();
    let changed = false;
    for (const [project, p] of Object.entries(pending)) {
      if (p.gaveUp) continue;
      if (now - p.since > S.giveUpMs || p.tries >= S.maxTries) {
        log('info', 'autoresume: gave up', { project, tries: p.tries });
        p.gaveUp = true; changed = true; continue;
      }
      if (now < p.at) continue;
      if (!D.enabled()) { delete pending[project]; changed = true; continue; }
      const sess = sessionName(project);
      if (!(await D.sessionUp(sess)) || !D.running(sess) || D.paused(sess) || (await D.activity(sess)) !== 'idle') {
        p.at = now + 60e3; changed = true; continue; // try again in a minute
      }
      // the window may still be full (limits polled late): ask again right before typing
      await D.refreshLimits();
      const t2 = D.now();
      const stillFull = windowsOf(D.limits(), project).some((w) => Number(w.percent) >= 100 && Date.parse(w.resetsAt || '') > t2);
      if (stillFull) { p.at = resumeAt(t2, project).at; changed = true; continue; }
      const ok = await D.type(sess, S.text);
      p.tries += 1; p.sentAt = D.now(); p.at = p.sentAt + S.fallbackMs; changed = true;
      log('info', 'autoresume: sent', { project, ok, tries: p.tries });
      if (ok) D.notify({ event: 'usage', project, key: 'resumed:' + project + ':' + p.sentAt, title: ['srv.push.resumed', { name: project }], body: [p.why === 'restart' ? 'srv.push.resumedRestartBody' : 'srv.push.resumedBody', { text: S.text }] });
    }
    if (changed) save();
  } catch (e) { log('error', 'autoresume: tick', { err: e.message }); }
  finally { busy = false; }
}

function list() {
  return Object.entries(pending).filter(([, p]) => !p.gaveUp).map(([project, p]) => ({ project, at: p.at, since: p.since, tries: p.tries, why: p.why }));
}
function cancel(project) { const had = !!pending[project]; delete pending[project]; if (had) save(); return had; }

// projects that were in the middle of a turn when the panel went down -> resume entries
function scheduleAfterRestart(now = D.now()) {
  turns = D.loadTurns();
  const out = [];
  if (!D.enabled()) return out;
  for (const [project, startedAt] of Object.entries(turns)) {
    if (pending[project]) continue; // already waiting (e.g. a usage limit)
    if (now - Number(startedAt) > S.turnMaxMs) { delete turns[project]; continue; }
    if (D.sessionMode(project) === 'new') continue; // fresh conversation: nothing to continue
    pending[project] = { since: now, at: now + S.restartDelayMs, why: 'restart', tries: 0, sentAt: 0 };
    out.push(project);
  }
  if (out.length) { save(); log('info', 'autoresume: resume after restart', { projects: out }); }
  D.saveTurns(turns);
  return out;
}

function start() {
  if (timer) return;
  pending = D.load();
  scheduleAfterRestart();
  timer = setInterval(() => { tick(); }, S.tickMs);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  start, stop, onHook, tick, list, cancel, resumeAt,
  scheduleAfterRestart, busyProjects: () => Object.keys(turns),
  _deps: D, _settings: S, _reset: () => { pending = {}; turns = {}; },
};
