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
});
const iso = (ms) => new Date(ms).toISOString();
const reset = () => { AR._reset(); typed = []; notes = []; saved = null; windows = []; Object.assign(env, { enabled: true, up: true, running: true, paused: false, activity: 'idle', typeOk: true }); };
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

  fs.rmSync(TMP, { recursive: true, force: true });
  out(`${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`);
  process.exit(fails ? 1 : 0);
})();
