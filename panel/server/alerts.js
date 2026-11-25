'use strict';
const { trOr } = require('./i18n');
// Alerts from the scripts (claude-loop.sh, backup.sh, memory guard...): they append
// JSON lines to RUN_DIR/alerts.jsonl ({t, level, kind, project?, msg}). The server reads only the
// NEW bytes (incremental offset), keeps the last 100 in memory and spreads them over SSE.
// Read by the health sampler (health.js, 60s) — NEVER on the watcher tick (2s): the file is
// small, but there is no reason to open/read/parse it every 2s just for that.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log } = require('./util');

const FILE = path.join(cfg.RUN_DIR, 'alerts.jsonl');
const MAX_KEEP = 100;
const LEVELS = new Set(['info', 'warn', 'error']);

let list = [];      // last MAX_KEEP alerts (newest at the end)
let offset = 0;      // bytes of the file already processed
let lastDiskAlertAt = 0;

// SSE notice of an alert; the browser translates it (alert.kind.<type> + key/vars)
const toNotice = (a) => ({
  kind: 'alert', t: a.t, level: a.level, alertKind: a.kind, project: a.project || '', msg: a.msg || '',
  title: trOr('alert.kind.' + a.kind, a.kind, {}, 'en') + (a.project ? ` — ${a.project}` : ''), body: a.msg || '',
  ...(a.key ? { key: a.key, vars: a.vars } : {}),
});

const plainVars = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).slice(0, 10)
  .filter(([k, x]) => /^\w{1,30}$/.test(k) && ['string', 'number'].includes(typeof x)).map(([k, x]) => [k, String(x).slice(0, 200)]));

function pushAndBroadcast(a) {
  list.push(a);
  if (list.length > MAX_KEEP) list.splice(0, list.length - MAX_KEEP);
  // lazy (avoids a cycle: events.js is the one that starts the sampler that calls into here)
  try {
    require('./events').broadcast('notify', toNotice(a));
  } catch { /* */ }
}

// reads the NEW lines since the last offset. If the file shrank (rotation/truncation by the
// scripts) the offset is invalid -> reopens from zero.
function poll() {
  let st;
  try { st = fs.statSync(FILE); } catch { offset = 0; return; }
  if (st.size < offset) offset = 0;
  if (st.size === offset) return;
  let buf;
  try {
    const fd = fs.openSync(FILE, 'r');
    try { buf = Buffer.alloc(st.size - offset); fs.readSync(fd, buf, 0, buf.length, offset); }
    finally { fs.closeSync(fd); }
  } catch (e) { log('error', 'alerts poll', { err: e.message }); return; }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return; // no complete new line yet
  const text = buf.subarray(0, lastNl + 1).toString('utf8');
  offset += lastNl + 1;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let raw; try { raw = JSON.parse(line); } catch { continue; }
    if (!raw || typeof raw !== 'object' || !raw.kind) continue;
    pushAndBroadcast({
      t: typeof raw.t === 'number' ? raw.t : Date.now(),
      level: LEVELS.has(raw.level) ? raw.level : 'info',
      kind: String(raw.kind).slice(0, 40),
      project: raw.project ? String(raw.project).slice(0, 80) : '',
      msg: String(raw.msg || '').slice(0, 500),
      // translatable text (optional): srv.* key + simple variables; msg is the fallback
      ...(typeof raw.key === 'string' && /^srv\.[\w.-]{1,60}$/.test(raw.key) ? { key: raw.key, vars: plainVars(raw.vars) } : {}),
    });
  }
}

// disk > 90%: at most 1x/hour, written to the SAME file that poll() reads (so the flow of
// "arrived -> goes into the list -> SSE" is a single one, like the alerts from the scripts).
function maybeDiskAlert(pct) {
  if (!(pct >= 90)) return;
  const now = Date.now();
  if (now - lastDiskAlertAt < 3600 * 1000) return;
  lastDiskAlertAt = now;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ t: now, level: 'warn', kind: 'disk', msg: trOr('srv.diskFull', `disk at ${pct}%`, { pct }, 'en'), key: 'srv.diskFull', vars: { pct } }) + '\n');
  } catch (e) { log('error', 'disk alert', { err: e.message }); }
}

// API: kind = alert type (old contract) + alertKind, the same mark as the SSE
const list100 = () => list.map((a) => ({ ...a, alertKind: a.kind }));
const clear = () => { list = []; };

module.exports = { poll, maybeDiskAlert, list100, clear };
