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
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sessionName, typeLine, log } = require('./util');

const FILE = path.join(cfg.RUN_DIR, 'autoresume.json');
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const S = {
  marginMs: num(process.env.AUTO_RESUME_MARGIN_SECONDS, 90) * 1000,      // after resetsAt
  fallbackMs: num(process.env.AUTO_RESUME_FALLBACK_SECONDS, 1800) * 1000, // reset time unknown
  tickMs: num(process.env.AUTO_RESUME_TICK_SECONDS, 15) * 1000,
  ownPromptMs: 120e3,          // a UserPromptSubmit this soon after our send is our own text
  maxTries: num(process.env.AUTO_RESUME_MAX_TRIES, 6),
  giveUpMs: 8 * 86400e3,       // the weekly window can take days
  text: String(process.env.AUTO_RESUME_TEXT || 'continue').slice(0, 200),
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
};

let pending = {}; // project -> { since, at, tries, sentAt, why }
let timer = null;
let busy = false;

const save = () => D.save(pending);

// When does the limit end? The latest reset among the plan windows at 100% (all of them must
// be free). None at 100% (the hit came from another window, or the poller is off): the earliest
// future reset among windows >= 90%; otherwise a fixed fallback.
function resumeAt(now = D.now()) {
  const snap = D.limits();
  const wins = (snap && snap.claude && Array.isArray(snap.claude.windows) ? snap.claude.windows : [])
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
  const p = pending[project];
  if (h.ev === 'StopFailure' && h.err === 'rate_limit') {
    if (!D.enabled()) return null;
    const { at, why } = resumeAt(t);
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
      const stillFull = ((D.limits() || {}).claude?.windows || []).some((w) => Number(w.percent) >= 100 && Date.parse(w.resetsAt || '') > t2);
      if (stillFull) { p.at = resumeAt(t2).at; changed = true; continue; }
      const ok = await D.type(sess, S.text);
      p.tries += 1; p.sentAt = D.now(); p.at = p.sentAt + S.fallbackMs; changed = true;
      log('info', 'autoresume: sent', { project, ok, tries: p.tries });
      if (ok) D.notify({ event: 'usage', project, key: 'resumed:' + project + ':' + p.sentAt, title: ['srv.push.resumed', { name: project }], body: ['srv.push.resumedBody', { text: S.text }] });
    }
    if (changed) save();
  } catch (e) { log('error', 'autoresume: tick', { err: e.message }); }
  finally { busy = false; }
}

function list() {
  return Object.entries(pending).filter(([, p]) => !p.gaveUp).map(([project, p]) => ({ project, at: p.at, since: p.since, tries: p.tries, why: p.why }));
}
function cancel(project) { const had = !!pending[project]; delete pending[project]; if (had) save(); return had; }

function start() {
  if (timer) return;
  pending = D.load();
  timer = setInterval(() => { tick(); }, S.tickMs);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  start, stop, onHook, tick, list, cancel, resumeAt,
  _deps: D, _settings: S, _reset: () => { pending = {}; },
};
