'use strict';
// "Update the panel" from the panel itself, without cutting Claude's work.
//
// DEPLOY_WEBHOOK_URL: the deploy hook of your hosting (most Docker panels and CI systems give
// one URL that rebuilds and restarts the app when called). Not set -> the feature is hidden.
//   now  -> calls the hook at once;
//   idle -> waits until no project has a turn in progress (the hooks say when a turn starts and
//           ends: server/autoresume.js), checking every 15 s, up to 6 h; then calls the hook.
// After the restart, projects that were still working are resumed by autoresume ("continue").
// The hook URL is a secret (it deploys): it is never sent to the browser nor written to the logs.
const { log } = require('./util');
const { tr } = require('./i18n');

const S = { checkMs: (Number(process.env.UPDATE_CHECK_SECONDS) || 15) * 1000, maxWaitMs: 6 * 3600e3 };
const D = {
  url: () => String(process.env.DEPLOY_WEBHOOK_URL || '').trim(),
  busy: () => require('./autoresume').busyProjects(),
  now: () => Date.now(),
  call: async (url) => {
    const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(30000) });
    return { ok: r.ok, status: r.status };
  },
};
let wait = null; // { since, timer }
let last = null; // { at, ok, status }

const configured = () => /^https?:\/\//.test(D.url());

function status() {
  return { ok: true, configured: configured(), waiting: !!wait, since: wait ? wait.since : 0, busy: configured() ? D.busy() : [], last };
}

async function fire() {
  stopWaiting();
  let r;
  try { r = await D.call(D.url()); } catch (e) { r = { ok: false, status: 0, err: e.name }; }
  last = { at: D.now(), ok: r.ok, status: r.status };
  log(r.ok ? 'info' : 'error', 'update: deploy hook called', { ok: r.ok, status: r.status });
  return r.ok ? { ok: true, msg: tr('srv.update.started') } : { ok: false, msg: tr('srv.update.failed', { status: r.status || r.err || '?' }) };
}

function stopWaiting() { if (wait) clearInterval(wait.timer); wait = null; }

async function check() {
  if (!wait) return null;
  if (D.now() - wait.since > S.maxWaitMs) { stopWaiting(); log('info', 'update: gave up waiting for idle sessions'); return null; }
  if (D.busy().length) return null;
  return fire();
}

// POST /api/update {mode: 'now' | 'idle' | 'cancel'}
async function request(mode) {
  if (!configured()) return { ok: false, msg: tr('srv.update.notConfigured') };
  if (mode === 'cancel') { stopWaiting(); return { ok: true, msg: tr('srv.update.cancelled') }; }
  if (mode === 'now') return fire();
  if (mode !== 'idle') return { ok: false, msg: tr('srv.badBody') };
  if (!D.busy().length) return fire();
  if (!wait) {
    wait = { since: D.now(), timer: setInterval(() => { check(); }, S.checkMs) };
    wait.timer.unref();
  }
  return { ok: true, waiting: true, msg: tr('srv.update.waiting', { names: D.busy().join(', ') }) };
}

module.exports = { status, request, check, _deps: D, _settings: S, _reset: () => { stopWaiting(); last = null; } };
