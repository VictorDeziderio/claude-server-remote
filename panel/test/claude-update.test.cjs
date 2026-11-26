#!/usr/bin/env node
// Unit test of server/claude-update.js (Claude Code update, by the button and automatic).
// Fake npm and fake `claude --version`: nothing is installed for real.
// Usage: node test/claude-update.test.cjs  (npm test runs it)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-test-'));
process.env.HOME = TMP;
process.env.PANEL_CONFIG = path.join(TMP, 'panel.json');
const U = require('../server/claude-update');
const D = U._deps;
console.log = () => {};

let fails = 0, passes = 0;
const out = (s) => process.stdout.write(s + '\n');
const ok = (name, cond, extra) => { out((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + (extra || ''))); cond ? passes++ : fails++; };

// ---- fakes: `installed` is what `claude --version` prints; `broken` versions install without the binary
let installed, latest, enabled, broken, npmFails, installs, notes;
const reset = () => { installed = '2.1.300'; latest = '2.1.310'; enabled = true; broken = new Set(); npmFails = false; installs = []; notes = []; U._reset(); };
Object.assign(D, {
  now: () => 1000,
  current: async () => installed,
  latest: async () => latest,
  install: async (v) => {
    installs.push(v);
    if (npmFails && v !== '2.1.300') return { ok: false, stdout: '', stderr: 'E404' };
    installed = broken.has(v) ? '' : v;
    return { ok: true, stdout: 'added 1 package', stderr: '' };
  },
  enabled: () => enabled,
  notify: (title, body) => { notes.push({ title, body }); },
});

(async () => {
  ok('newer(): compares x.y.z numerically', U.newer('2.1.310', '2.1.99') && !U.newer('2.1.99', '2.1.310') && !U.newer('2.1.3', '2.1.3') && U.newer('3.0.0', '2.9.9'));
  ok('newer(): garbage is never newer', !U.newer('', '2.1.3') && !U.newer('latest', '2.1.3'));

  reset();
  let r = await U.tick();
  ok('auto: installs the newer version', r.ok && installed === '2.1.310' && installs.join() === '2.1.310', JSON.stringify({ r, installs }));
  ok('auto: tells the owner (push "update")', notes.length === 1 && /2\.1\.310/.test(notes[0].title), JSON.stringify(notes));
  ok('status: last update recorded', U.status().last && U.status().last.ok && U.status().last.from === '2.1.300' && U.status().last.to === '2.1.310');

  reset(); latest = '2.1.300';
  r = await U.tick();
  ok('auto: same version -> installs nothing', r.ok && installs.length === 0 && notes.length === 0, JSON.stringify({ r, installs }));

  reset(); latest = '2.1.200';
  r = await U.tick();
  ok('auto: never downgrades', installs.length === 0 && installed === '2.1.300');

  reset(); enabled = false;
  r = await U.tick();
  ok('auto: switch off -> does nothing', r === null && installs.length === 0);
  ok('status: switch off -> no next check shown', U.status().enabled === false && U.status().nextAt === 0);

  reset(); broken.add('2.1.310');
  r = await U.tick();
  ok('binary missing -> tries again, then goes back to the old version', !r.ok && installs.join() === '2.1.310,2.1.310,2.1.300' && installed === '2.1.300', JSON.stringify({ installs, installed }));
  ok('failure -> owner is told, status shows it', notes.length === 1 && U.status().last && U.status().last.ok === false);

  reset(); npmFails = true;
  r = await U.updateNow();
  ok('button: npm error -> message + old version kept', !r.ok && installed === '2.1.300' && /2\.1\.300/.test(r.msg), JSON.stringify(r));
  ok('button: no push for a manual update', notes.length === 0);

  reset(); latest = '';
  r = await U.updateNow();
  ok('npm unreachable -> clear message, nothing installed', !r.ok && installs.length === 0);

  reset();
  const [a, b] = await Promise.all([U.updateNow(), U.updateNow()]);
  ok('two clicks at once -> one install', installs.length === 1 && a.ok && !b.ok, JSON.stringify({ installs, a, b }));

  out(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})();
