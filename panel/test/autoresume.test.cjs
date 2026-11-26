#!/usr/bin/env node
// Unit test of server/autoresume.js ("continue" by itself after a usage-limit reset).
// Fake clock, fake plan windows and fake tmux: nothing real is typed anywhere.
// Usage: node test/autoresume.test.cjs  (npm test runs it)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-test-'));
process.env.HOME = TMP;
process.env.PROJECTS_DIR = path.join(TMP, 'projects');
process.env.PANEL_CONFIG = path.join(TMP, 'panel.json');
const AR = require('../server/autoresume');
const D = AR._deps;
const S = AR._settings;
console.log = () => {}; // module logs (JSON lines) would mix with the report

let fails = 0, passes = 0;
const out = (s) => process.stdout.write(s + '\n');
const ok = (name, cond, extra) => { out((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + (extra || ''))); cond ? passes++ : fails++; };

// ---- fakes ----
const H = 3600e3;
let now = Date.parse('2026-11-25T10:00:00Z');
let windows = [];
let typed = [];
let notes = [];
let saved = null;
let savedTurns = {};
let modes = {};
const env = { enabled: true, up: true, running: true, paused: false, activity: 'idle', typeOk: true };
Object.assign(D, {
  now: () => now,
  enabled: () => env.enabled,
  limits: () => ({ claude: { windows } }),
  refreshLimits: async () => {},
  sessionUp: async () => env.up,
  running: () => env.running,
  paused: () => env.paused,
  activity: () => env.activity,
  type: async (sess, text) => { typed.push([sess, text]); return env.typeOk; },
  notify: (ev) => notes.push(ev),
  save: (o) => { saved = JSON.parse(JSON.stringify(o)); },
  load: () => (saved ? JSON.parse(JSON.stringify(saved)) : {}),
  saveTurns: (o) => { savedTurns = JSON.parse(JSON.stringify(o)); },
  loadTurns: () => JSON.parse(JSON.stringify(savedTurns)),
  sessionMode: (p) => modes[p] || 'continue',
});
const iso = (ms) => new Date(ms).toISOString();
const reset = () => { AR._reset(); typed = []; notes = []; saved = null; savedTurns = {}; modes = {}; windows = []; Object.assign(env, { enabled: true, up: true, running: true, paused: false, activity: 'idle', typeOk: true }); };
const hit = (project = 'demo') => AR.onHook({ ev: 'StopFailure', err: 'rate_limit' }, project, now);
const item = (p = 'demo') => AR.list().find((x) => x.project === p);

(async () => {
  out('== reset time from the plan windows');
  reset();
  windows = [{ id: 'five_hour', percent: 100, resetsAt: iso(now + 2 * H) }, { id: 'seven_day', percent: 40, resetsAt: iso(now + 50 * H) }];
  let r = hit();
  ok('5h window at 100% -> its reset + margin', r && r.at === now + 2 * H + S.marginMs, JSON.stringify(r));
  windows = [{ id: 'five_hour', percent: 100, resetsAt: iso(now + 2 * H) }, { id: 'seven_day', percent: 100, resetsAt: iso(now + 50 * H) }];
  r = hit();
  ok('two windows at 100% -> waits for the LATER one', r.at === now + 50 * H + S.marginMs);
  windows = [{ id: 'five_hour', percent: 93, resetsAt: iso(now + 1 * H) }];
  ok('none at 100% -> earliest reset among >= 90%', AR.resumeAt(now).at === now + H + S.marginMs);
  windows = [];
  ok('no data -> fallback delay', AR.resumeAt(now).at === now + S.fallbackMs && AR.resumeAt(now).why === 'fallback');
  windows = [{ id: 'five_hour', percent: 100, resetsAt: iso(now - 60e3) }];
  ok('reset already in the past is ignored', AR.resumeAt(now).why === 'fallback');
  ok('saved to disk (survives a panel restart)', saved && saved.demo && saved.demo.at > now);

  out('== sends "continue" only at the time, only when safe');
  reset();
  windows = [{ id: 'five_hour', percent: 100, resetsAt: iso(now + H) }];
  hit();
  await AR.tick();
  ok('before the reset: types nothing', typed.length === 0);
  now += H + S.marginMs + 1000;
  windows = [{ id: 'five_hour', percent: 3, resetsAt: iso(now + 5 * H) }]; // window renewed
  await AR.tick();
  ok('after the reset: types "continue" in the project session', typed.length === 1 && typed[0][0] === 'claude-demo' && typed[0][1] === S.text, JSON.stringify(typed));
  ok('push "resumed automatically" (key + vars, translated per device)', notes.length === 1 && notes[0].title[0] === 'srv.push.resumed' && notes[0].title[1].name === 'demo' && notes[0].body[1].text === S.text && notes[0].project === 'demo', JSON.stringify(notes[0]));
  AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now + 2000);
  ok('our own prompt does not cancel the entry', !!item());
  AR.onHook({ ev: 'Stop' }, 'demo', now + 60e3);
  ok('turn finished (Stop) -> entry cleared', !item());

  reset();
  hit();
  now += S.fallbackMs + 1000;
  windows = [{ id: 'five_hour', percent: 100, resetsAt: iso(now + 30 * 60e3) }]; // poller was late: still full
  await AR.tick();
  ok('still at 100% at the time -> waits for the new reset, types nothing', typed.length === 0 && item().at === now + 30 * 60e3 + S.marginMs);

  for (const [k, v, label] of [['up', false, 'session down'], ['running', false, 'Claude not running'], ['paused', true, 'project paused'], ['activity', 'busy', 'screen busy'], ['activity', 'prompt', 'a dialog is open']]) {
    reset(); hit(); now += S.fallbackMs + 1000; env[k] = v;
    await AR.tick();
    ok(`${label} -> does not type, tries again in a minute`, typed.length === 0 && item() && item().at === now + 60e3);
  }

  out('== cancel / give up / off');
  reset(); hit();
  AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now + 5000);
  ok('the person typed something -> cancelled', !item());
  reset(); env.enabled = false;
  ok('feature off -> nothing scheduled', hit() === null && !item());
  reset(); hit(); env.enabled = false; now += S.fallbackMs + 1000;
  await AR.tick();
  ok('turned off while waiting -> dropped without typing', typed.length === 0 && !item());
  reset(); hit();
  for (let i = 0; i < S.maxTries + 2; i++) { now += S.fallbackMs + 1000; await AR.tick(); hit(); }
  ok(`gives up after ${S.maxTries} sends`, typed.length === S.maxTries, String(typed.length));
  ok('given up -> not shown as waiting', !item());
  AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now + S.ownPromptMs + 1); hit();
  ok('the person types again and hits the limit -> scheduled again from zero', item() && item().tries === 0);
  reset(); hit(); now += S.giveUpMs + 1000; await AR.tick();
  ok('gives up after the max wait', typed.length === 0 && !item());
  reset();
  AR.onHook({ ev: 'StopFailure', err: 'billing_error' }, 'demo', now);
  ok('billing error (no reset coming) -> not scheduled', !item());
  ok('hook without a project -> ignored', AR.onHook({ ev: 'StopFailure', err: 'rate_limit' }, '', now) === null);
  reset(); hit('a'); hit('b');
  AR.onHook({ ev: 'UserPromptSubmit' }, 'a', now + 1);
  ok('each project on its own', !item('a') && !!item('b'));

  out('== restart in the middle of a turn (deploy / container restart)');
  reset();
  AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now);
  ok('a turn in progress is saved to disk', savedTurns.demo === now, JSON.stringify(savedTurns))
  AR.onHook({ ev: 'Stop' }, 'demo', now + 5000);
  ok('turn finished -> no longer saved', !('demo' in savedTurns))
  AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now); AR.onHook({ ev: 'UserPromptSubmit' }, 'fresh', now); modes.fresh = 'new'
  AR._reset(); // the panel went down: memory lost, the disk file stays
  let sch = AR.scheduleAfterRestart(now + 60e3)
  ok('panel starts again -> resume scheduled for the interrupted project', sch.join() === 'demo' && item().why === 'restart' && item().at === now + 60e3 + S.restartDelayMs, JSON.stringify(sch))
  ok('sessionMode "new" (fresh conversation) -> nothing to continue', !item('fresh'))
  now += 60e3 + S.restartDelayMs + 1000
  await AR.tick()
  ok('after the delay, idle screen -> types "continue"', typed.length === 1 && typed[0][1] === S.text)
  ok('push says it was a restart', notes[0] && notes[0].body[0] === 'srv.push.resumedRestartBody')
  AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now + 1000)
  ok('our own "continue" does not cancel it', !!item())
  AR.onHook({ ev: 'Stop' }, 'demo', now + 30e3)
  ok('turn ends -> cleared', !item() && !('demo' in savedTurns))

  reset(); AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now); AR._reset()
  AR.scheduleAfterRestart(now + 1000)
  AR.onHook({ ev: 'Stop' }, 'demo', now + 2000)
  ok('only the panel restarted and Claude finished by itself -> nothing typed', !item() && typed.length === 0)

  reset(); AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now); AR._reset(); env.activity = 'busy'
  AR.scheduleAfterRestart(now + 1000); now += S.restartDelayMs + 5000; await AR.tick()
  ok('Claude still working after the restart -> waits, types nothing', typed.length === 0 && !!item())

  reset(); AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now); AR._reset(); env.enabled = false
  ok('feature off -> nothing scheduled after restart', AR.scheduleAfterRestart(now + 1000).length === 0 && !item())
  reset(); AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now); AR._reset()
  ok('stale turn (lost Stop, > 12 h) -> ignored', AR.scheduleAfterRestart(now + S.turnMaxMs + 1000).length === 0)
  reset(); windows = [{ id: 'five_hour', percent: 100, resetsAt: iso(now + H) }]
  AR.onHook({ ev: 'UserPromptSubmit' }, 'demo', now); hit() // turn started, then the limit hit (StopFailure ends the turn)
  const keepAt = item().at
  savedTurns = { demo: now } // even if a turn were still marked
  AR._reset(); AR.start(); AR.stop() // panel restarts: loads the saved entries
  ok('a usage-limit entry already waiting is kept (not replaced by restart)', item() && item().why === 'reset' && item().at === keepAt, JSON.stringify(item()))

  out('== per Claude account: the windows of the account the project uses');
  reset();
  {
    const keepLimits = D.limits, keepAccount = D.account;
    const workWins = [{ id: 'five_hour', percent: 100, resetsAt: iso(now + 4 * H) }];
    windows = [{ id: 'five_hour', percent: 100, resetsAt: iso(now + 1 * H) }];
    D.limits = () => ({ claude: { windows }, accounts: { work: { windows: workWins } } });
    D.account = (p) => (p === 'onwork' ? 'work' : 'default');
    const rw = hit('onwork'), rd = hit('demo');
    ok('project on another account -> reset of THAT account', rw && rw.at === now + 4 * H + S.marginMs, JSON.stringify(rw));
    ok('project on the default account -> default windows', rd && rd.at === now + 1 * H + S.marginMs, JSON.stringify(rd));
    D.account = () => 'gone';
    ok('account without limits data -> fallback delay', AR.resumeAt(now, 'x').why === 'fallback');
    D.limits = keepLimits; D.account = keepAccount;
  }

  out('\n== a `claude -p` run (no terminal) never leaves a turn open (bug: deploy typed "continue")')
  reset()
  {
    const N = require('../server/notify')
    const cwd = path.join(TMP, 'projects', 'demo')
    const T0 = Date.now()
    N.handleHook({ ev: 'UserPromptSubmit', tty: 0, src: '', sid: 'p1', cwd, t: T0 }, T0)
    N.handleHook({ ev: 'Stop', tty: 0, src: '', sid: 'p1', cwd, t: T0 + 1000, msg: 'done' }, T0 + 1000)
    ok('headless run: no turn kept for the restart', AR.busyProjects().length === 0, JSON.stringify(AR.busyProjects()))
    ok('headless run: restart schedules nothing', AR.scheduleAfterRestart(T0 + 2000).length === 0)
    N.handleHook({ ev: 'UserPromptSubmit', tty: 1, src: '', sid: 'i1', cwd, t: T0 + 3000 }, T0 + 3000)
    ok('terminal session: turn in progress is kept', AR.busyProjects().includes('demo'))
    N.handleHook({ ev: 'Stop', tty: 1, src: '', sid: 'i1', cwd, t: T0 + 4000, msg: 'ok' }, T0 + 4000)
    ok('terminal session: its Stop closes the turn', AR.busyProjects().length === 0)
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  out(`${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`);
  process.exit(fails ? 1 : 0);
})();
