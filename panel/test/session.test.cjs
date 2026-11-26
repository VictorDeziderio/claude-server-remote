#!/usr/bin/env node
// Unit test of the panel session lifetime (server/auth.js + server/sessions.js): one year by
// default, renewed while the device uses the panel (sliding expiry), at most once a day.
// Usage: node test/session.test.cjs  (npm test runs it)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-test-'));
process.env.HOME = TMP;
delete process.env.PANEL_SESSION_DAYS;
process.env.PANEL_LOGIN = 'admin';
process.env.PANEL_PASSWORD = 'a-long-test-password-123';
process.env.PANEL_TEST_INSECURE_COOKIE = '1';
const cfg = require('../server/config');
const auth = require('../server/auth');
const sessions = require('../server/sessions');
console.log = () => {};

let fails = 0, passes = 0;
const out = (s) => process.stdout.write(s + '\n');
const ok = (name, cond, extra) => { out((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   -> ' + (extra || ''))); cond ? passes++ : fails++; };

const fakeRes = () => { const h = {}; return { headersSent: false, setHeader: (k, v) => { h[k.toLowerCase()] = v; }, h }; };
const req = (cookie) => ({ headers: { cookie: cookie || '', 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } });
const maxAge = (c) => Number((/Max-Age=(\d+)/.exec(c || '') || [])[1]);
const DAY = 86400;

ok('default lifetime is one year', cfg.SESSION_DAYS === 365, String(cfg.SESSION_DAYS));

let res = fakeRes();
const r = auth.doLogin({ login: 'admin', password: 'a-long-test-password-123' }, req(), res);
const set = res.h['set-cookie'];
ok('login ok, cookie lasts one year', r.ok && Math.abs(maxAge(set) - 365 * DAY) < 5, set);
const cookie = set.split(';')[0];
const sid = auth.sessionId(req(cookie));
ok('cookie is a valid session', !!sid);

res = fakeRes(); auth.renew(req(cookie), res);
ok('fresh session: no renewal (at most once a day)', !res.h['set-cookie']);

// the session was created 200 days ago: 165 days left
sessions.get(sid).exp = Math.floor(Date.now() / 1000) + 165 * DAY;
res = fakeRes(); auth.renew(req(cookie), res);
const c2 = res.h['set-cookie'];
ok('session in use is renewed to one year from now', c2 && Math.abs(maxAge(c2) - 365 * DAY) < 5 && sessions.get(sid).exp > Date.now() / 1000 + 364 * DAY, c2);
ok('the renewed cookie still signs in (same session)', auth.sessionId(req(c2.split(';')[0])) === sid);
res = fakeRes(); auth.renew(req(c2.split(';')[0]), res);
ok('second request the same day: no new cookie', !res.h['set-cookie']);

res = fakeRes(); auth.renew(req('cr_session=garbage'), res);
ok('no valid session: nothing renewed', !res.h['set-cookie']);

sessions.revoke(sid);
res = fakeRes(); auth.renew(req(c2.split(';')[0]), res);
ok('revoked session is not brought back', !res.h['set-cookie'] && !auth.sessionId(req(c2.split(';')[0])));

out(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
