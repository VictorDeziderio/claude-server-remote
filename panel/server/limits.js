'use strict';
const { tr } = require('./i18n');
/*
 * Plan limits + API spend monitor (polls in the background, caches to the volume).
 *
 * 1) Claude subscription (Pro/Max) logged in on this box: the same numbers Claude Code's
 *    `/usage` shows — current 5-hour session window, weekly limits (all models + per-model
 *    when the plan has them) and extra usage, each with its reset time.
 *    Source: GET {base}/api/oauth/usage with the OAuth access token from
 *    ~/.claude/.credentials.json (claudeAiOauth.accessToken) and the header
 *    `anthropic-beta: oauth-2025-04-20` — the endpoint and beta value the installed CLI
 *    (2.1.x) uses. `?skip_spend=1` is the CLI's lighter "windows only" read.
 *    This module NEVER refreshes or rotates the token: the Claude CLI owns the refresh token
 *    (it rewrites the file when it refreshes). We only re-read the file each poll. An expired
 *    token is not sent at all; a 401 is remembered per token (fingerprint only, never the
 *    token) and not retried until the file holds a different token -> UI says "Reconnect Claude".
 *
 * 2) Anthropic API spend (only when ANTHROPIC_ADMIN_KEY is set): official Admin API
 *    GET {base}/v1/organizations/cost_report (daily buckets, amounts in cents as decimal
 *    strings). There is NO public credit-balance endpoint, so we show spend today / this month
 *    (UTC) and say so. Optional ANTHROPIC_API_BUDGET_USD turns the month into a % for alerts.
 *
 * Env vars (all optional):
 *   USAGE_MONITOR=0                 disable polling entirely
 *   USAGE_POLL_INTERVAL=300         seconds between polls (min 60). Errors back off x2 up to 1h
 *   USAGE_THRESHOLDS=80,95          % levels that fire threshold events / panel alerts
 *   USAGE_MIN_REFRESH_SECONDS=15    min gap between manual refreshes (POST /api/limits/refresh)
 *   USAGE_API_BASE_URL              default https://api.anthropic.com (tests point it at a fake)
 *   USAGE_CREDENTIALS_FILE          default ~/.claude/.credentials.json
 *   ANTHROPIC_ADMIN_KEY             Admin API key (sk-ant-admin...) -> API spend card
 *   ANTHROPIC_API_BUDGET_USD        monthly budget -> % + threshold alerts for API spend
 *
 * Hooks for other modules (e.g. push notifications):
 *   const limits = require('./limits')
 *   const off = limits.onUsage((snapshot) => { ... })   // after every poll (success or error)
 *   const off2 = limits.onThreshold((ev) => { ... })    // a window crossed a threshold
 *     ev = { source: 'claude'|'api', id, label, percent, threshold, resetsAt, level, t }
 *   Each (window, reset period) fires once per threshold level (persisted across restarts).
 *   Threshold crossings are also appended to RUN_DIR/alerts.jsonl (kind "usage"), so they show
 *   up in the panel's alert list like the other alerts.
 *   limits.snapshot() returns the last public snapshot (no secrets).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const cfg = require('./config');
const { log } = require('./util');

const num = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const S = {
  enabled: process.env.USAGE_MONITOR !== '0',
  intervalMs: Math.max(60, num(process.env.USAGE_POLL_INTERVAL, 300)) * 1000,
  minRefreshMs: Math.max(0, num(process.env.USAGE_MIN_REFRESH_SECONDS, 15)) * 1000,
  thresholds: String(process.env.USAGE_THRESHOLDS || '80,95').split(',').map((x) => Number(x.trim()))
    .filter((x) => x > 0 && x <= 100).sort((a, b) => a - b),
  base: String(process.env.USAGE_API_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  credFile: process.env.USAGE_CREDENTIALS_FILE || path.join(cfg.CLAUDE_DIR, '.credentials.json'),
  cacheFile: path.join(cfg.RUN_DIR, 'usage-limits.json'),
  alertsFile: path.join(cfg.RUN_DIR, 'alerts.jsonl'),
  budgetUsd: num(process.env.ANTHROPIC_API_BUDGET_USD, 0),
  maxBackoffMs: 3600 * 1000,
  timeoutMs: 10000,
};
const adminKey = () => process.env.ANTHROPIC_ADMIN_KEY || '';

const bus = new EventEmitter();
bus.setMaxListeners(50);
const fp = (tok) => crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16); // never store the token

let state = {
  claude: { status: 'pending', message: 'Not checked yet', windows: [], extra: null, plan: '', fetchedAt: 0, stale: false },
  api: { configured: !!adminKey(), status: adminKey() ? 'pending' : 'not_configured', message: '', currency: 'USD', today: null, month: null, monthStart: '', budget: S.budgetUsd || null, percent: null, fetchedAt: 0, stale: false,
    note: 'Anthropic has no public balance endpoint: this is spend from the Admin API cost report (UTC days, may lag ~5 min).' },
  updatedAt: 0,
  nextPollAt: 0,
};
let alerted = {};          // `${source}:${id}:${resetsAt}` -> highest threshold already fired
let rejectedToken = '';    // fingerprint of a token that got 401 (not retried)
let failures = 0;
let timer = null;
let inflight = null;
let lastManual = 0;

// ---------- cache (volume) ----------
function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(S.cacheFile, 'utf8'));
    if (c && c.claude) state.claude = { ...state.claude, ...c.claude, stale: true };
    if (c && c.api && adminKey()) state.api = { ...state.api, ...c.api, configured: true, stale: true };
    if (c && c.alerted && typeof c.alerted === 'object') alerted = c.alerted;
    if (c && typeof c.rejectedToken === 'string') rejectedToken = c.rejectedToken;
    state.updatedAt = c.updatedAt || 0;
  } catch { /* first run */ }
}
function saveCache() {
  try {
    fs.mkdirSync(path.dirname(S.cacheFile), { recursive: true });
    const tmp = S.cacheFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ claude: state.claude, api: state.api, updatedAt: state.updatedAt, alerted, rejectedToken }), { mode: 0o600 });
    fs.renameSync(tmp, S.cacheFile);
  } catch (e) { log('error', 'limits cache', { err: e.message }); }
}

// ---------- http ----------
async function getJson(url, headers) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), S.timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': `claude-remote-panel/${cfg.PANEL_VERSION}`, ...headers }, signal: ac.signal });
    let data = null;
    try { data = await r.json(); } catch { /* not json */ }
    return { status: r.status, data, retryAfter: num(r.headers.get('retry-after'), 0) };
  } finally { clearTimeout(t); }
}

// ---------- Claude subscription ----------
function readToken() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(S.credFile, 'utf8')); } catch { /* missing / unreadable */ }
  const o = j && j.claudeAiOauth;
  if (o && typeof o.accessToken === 'string' && o.accessToken) {
    return { token: o.accessToken, expiresAt: num(o.expiresAt, 0), plan: String(o.subscriptionType || '') };
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, expiresAt: 0, plan: '' };
  return null;
}

const WINDOW_LABELS = {
  five_hour: 'Current session (5h)',
  seven_day: 'Current week (all models)',
  seven_day_opus: 'Current week (Opus)',
  seven_day_sonnet: 'Current week (Sonnet)',
  seven_day_oauth_apps: 'Current week (OAuth apps)',
  seven_day_cowork: 'Current week (Cowork)',
};
const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10) / 10)) : null; };
// reset times come with jittering microseconds (07:30:00.059 then 07:30:00.039): round to the
// minute so the same period keeps the same key (threshold events fire once per period)
const iso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(Math.round(t / 60000) * 60000).toISOString() : null; };

// response -> [{id,label,percent,resetsAt,severity}] + extra usage. Unknown keys are ignored
// (the endpoint carries many experimental fields); null windows are not part of the plan.
function parseClaude(d) {
  const windows = [];
  if (!d || typeof d !== 'object') return { windows, extra: null };
  for (const [id, label] of Object.entries(WINDOW_LABELS)) {
    const w = d[id];
    if (!w || typeof w !== 'object' || pct(w.utilization) === null) continue;
    windows.push({ id, label, percent: pct(w.utilization), resetsAt: iso(w.resets_at), severity: '' });
  }
  // newer `limits` array: per-model weekly limits (scope.model.display_name) not covered above
  if (Array.isArray(d.limits)) {
    for (const l of d.limits) {
      if (!l || typeof l !== 'object' || pct(l.percent) === null) continue;
      const model = l.scope && l.scope.model && l.scope.model.display_name;
      const sev = typeof l.severity === 'string' ? l.severity : '';
      if (!model) { // session / weekly_all duplicate five_hour / seven_day: only take the severity
        const twin = windows.find((w) => w.id === (l.kind === 'session' ? 'five_hour' : l.kind === 'weekly_all' ? 'seven_day' : ''));
        if (twin) { twin.severity = sev; continue; }
        if (l.kind === 'session' || l.kind === 'weekly_all') {
          windows.push({ id: l.kind === 'session' ? 'five_hour' : 'seven_day', label: l.kind === 'session' ? WINDOW_LABELS.five_hour : WINDOW_LABELS.seven_day, percent: pct(l.percent), resetsAt: iso(l.resets_at), severity: sev });
        }
        continue;
      }
      const id = 'model:' + String(model).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      if (windows.some((w) => w.id === id || w.label === `Current week (${model})`)) continue;
      windows.push({ id, label: `Current week (${String(model).slice(0, 40)})`, percent: pct(l.percent), resetsAt: iso(l.resets_at), severity: sev });
    }
  }
  let extra = null;
  const e = d.extra_usage;
  if (e && typeof e === 'object' && e.is_enabled === true) {
    const div = 10 ** (Number.isInteger(e.decimal_places) ? e.decimal_places : 2);
    extra = {
      percent: pct(e.utilization),
      used: Number.isFinite(Number(e.used_credits)) ? Number(e.used_credits) / div : null,
      limit: Number.isFinite(Number(e.monthly_limit)) ? Number(e.monthly_limit) / div : null,
      currency: typeof e.currency === 'string' && e.currency ? e.currency : 'USD',
    };
  }
  return { windows, extra };
}

async function pollClaude() {
  const c = state.claude;
  const cred = readToken();
  if (!cred) return Object.assign(c, { status: 'not_logged_in', message: 'Claude is not logged in on this server (or uses an API key, which has no plan limits).', windows: [], extra: null, plan: '', stale: false });
  c.plan = cred.plan;
  const f = fp(cred.token);
  if (cred.expiresAt && cred.expiresAt <= Date.now()) {
    // the CLI refreshes it on its next request; we never do. Re-read on the next poll.
    return Object.assign(c, { status: 'expired', message: 'The Claude login token has expired. It renews when Claude Code runs; if it stays like this, reconnect Claude.', stale: c.windows.length > 0 });
  }
  if (f === rejectedToken) return Object.assign(c, { status: 'auth_error', message: 'Claude rejected the login token. Reconnect Claude.', stale: c.windows.length > 0 });
  const r = await getJson(`${S.base}/api/oauth/usage?skip_spend=1`, {
    Authorization: `Bearer ${cred.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json',
  });
  if (r.status === 401 || r.status === 403) {
    rejectedToken = f;
    log('warn', 'limits: claude usage auth error', { status: r.status });
    return Object.assign(c, { status: 'auth_error', message: 'Claude rejected the login token. Reconnect Claude.', stale: c.windows.length > 0 });
  }
  if (r.status !== 200 || !r.data) {
    const err = new Error(`Claude usage endpoint answered HTTP ${r.status}`);
    err.retryAfter = r.retryAfter;
    throw err;
  }
  const { windows, extra } = parseClaude(r.data);
  return Object.assign(c, { status: 'ok', message: windows.length ? '' : 'No plan limits reported for this account.', windows, extra, fetchedAt: Date.now(), stale: false });
}

// ---------- Anthropic API spend (Admin API) ----------
const dayStr = (d) => d.toISOString().slice(0, 10);
async function pollApi() {
  const a = state.api;
  const key = adminKey();
  a.configured = !!key;
  if (!key) return Object.assign(a, { status: 'not_configured', message: 'Set ANTHROPIC_ADMIN_KEY to show API spend.', today: null, month: null });
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const today = dayStr(now);
  let month = 0, todaySum = 0, page = '', currency = 'USD';
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ starting_at: start.toISOString().replace('.000Z', 'Z'), ending_at: end.toISOString().replace('.000Z', 'Z'), bucket_width: '1d', limit: '31' });
    if (page) q.set('page', page);
    const r = await getJson(`${S.base}/v1/organizations/cost_report?${q}`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
    if (r.status === 401 || r.status === 403) {
      log('warn', 'limits: admin api auth error', { status: r.status });
      return Object.assign(a, { status: 'auth_error', message: 'The Admin API key was rejected (it must be an Admin key, sk-ant-admin...).', stale: a.month !== null });
    }
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.data)) {
      const err = new Error(`Admin API cost report answered HTTP ${r.status}`);
      err.retryAfter = r.retryAfter;
      throw err;
    }
    for (const b of r.data.data) {
      let sum = 0;
      for (const x of (b && Array.isArray(b.results) ? b.results : [])) {
        const cents = Number(x && x.amount);
        if (Number.isFinite(cents)) sum += cents;
        if (x && typeof x.currency === 'string') currency = x.currency;
      }
      month += sum;
      if (String(b.starting_at || '').slice(0, 10) === today) todaySum += sum;
    }
    if (!r.data.has_more || !r.data.next_page) break;
    page = String(r.data.next_page);
  }
  const monthUsd = Math.round(month) / 100;
  return Object.assign(a, {
    status: 'ok', message: '', currency, today: Math.round(todaySum) / 100, month: monthUsd, monthStart: dayStr(start),
    budget: S.budgetUsd || null, percent: S.budgetUsd ? pct((monthUsd / S.budgetUsd) * 100) : null, fetchedAt: Date.now(), stale: false,
  });
}

// ---------- thresholds ----------
function checkThresholds() {
  if (!S.thresholds.length) return;
  const items = [];
  if (state.claude.status === 'ok') for (const w of state.claude.windows) items.push({ source: 'claude', ...w });
  if (state.claude.status === 'ok' && state.claude.extra && state.claude.extra.percent !== null) items.push({ source: 'claude', id: 'extra_usage', label: 'Extra usage', percent: state.claude.extra.percent, resetsAt: null });
  if (state.api.status === 'ok' && state.api.percent !== null) items.push({ source: 'api', id: 'month', label: 'API spend this month', percent: state.api.percent, resetsAt: state.api.monthStart });
  const now = Date.now();
  // forget periods that already reset (keeps the file small). Claude keys carry the reset time,
  // the API key carries the month start.
  for (const k of Object.keys(alerted)) {
    const at = Date.parse(k.split('|')[1] || '');
    const keep = k.startsWith('api:') ? 40 * 86400000 : 86400000;
    if (Number.isFinite(at) && at < now - keep) delete alerted[k];
  }
  for (const it of items) {
    const key = `${it.source}:${it.id}|${it.resetsAt || ''}`;
    const crossed = S.thresholds.filter((t) => it.percent >= t);
    if (!crossed.length) continue;
    const top = crossed[crossed.length - 1];
    if ((alerted[key] || 0) >= top) continue;
    alerted[key] = top;
    const ev = { source: it.source, id: it.id, label: it.label, percent: it.percent, threshold: top, resetsAt: it.resetsAt || null,
      level: top === S.thresholds[S.thresholds.length - 1] ? 'error' : 'warn', t: now };
    try {
      fs.mkdirSync(path.dirname(S.alertsFile), { recursive: true });
      const when = ev.resetsAt && ev.source === 'claude' ? ` (resets ${new Date(ev.resetsAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
      fs.appendFileSync(S.alertsFile, JSON.stringify({ t: now, level: ev.level, kind: 'usage', msg: `${ev.label}: ${ev.percent}% used${when}` }) + '\n');
    } catch (e) { log('error', 'limits alert', { err: e.message }); }
    try { require('./alerts').poll(); } catch { /* */ }
    emit('threshold', ev);
  }
}

function emit(name, payload) {
  for (const fn of bus.listeners(name)) {
    try { fn(payload); } catch (e) { log('error', 'limits listener', { event: name, err: e.message }); }
  }
}

// ---------- loop ----------
function snapshot() {
  return { ok: true, enabled: S.enabled, intervalSec: S.intervalMs / 1000, thresholds: S.thresholds.slice(), updatedAt: state.updatedAt, nextPollAt: state.nextPollAt,
    claude: { ...state.claude, windows: state.claude.windows.map((w) => ({ ...w })) }, api: { ...state.api } };
}

async function pollOnce() {
  let errMs = 0;
  const run = async (fn, part) => {
    try { await fn(); } catch (e) {
      const msg = e.name === 'AbortError' ? 'Request timed out' : e.message;
      log('warn', 'limits poll failed', { part, err: msg });
      const s = state[part];
      Object.assign(s, { status: 'error', message: `Could not refresh: ${msg}. Showing the last known values.`, stale: true });
      errMs = Math.max(errMs, (e.retryAfter || 0) * 1000, 1);
    }
  };
  await run(pollClaude, 'claude');
  await run(pollApi, 'api');
  state.updatedAt = Date.now();
  failures = errMs ? failures + 1 : 0;
  checkThresholds();
  saveCache();
  return errMs;
}

function schedule(ms) {
  if (timer) clearTimeout(timer);
  state.nextPollAt = Date.now() + ms;
  timer = setTimeout(tick, ms);
  timer.unref();
}
async function tick() {
  if (!inflight) inflight = pollOnce().finally(() => { inflight = null; });
  const errMs = await inflight;
  const next = errMs ? Math.min(S.maxBackoffMs, Math.max(errMs, S.intervalMs * 2 ** Math.min(failures, 6))) : S.intervalMs;
  schedule(next);
  const snap = snapshot();
  emit('usage', snap);
  try { require('./events').broadcast('limits', snap); } catch { /* */ }
  return snap;
}

function start() {
  if (!S.enabled || timer) return;
  loadCache();
  schedule(1000); // first poll right after boot
}
function stop() { if (timer) clearTimeout(timer); timer = null; }

// POST /api/limits/refresh — coalesced with an in-flight poll; min gap against button mashing
async function refresh() {
  if (!S.enabled) return { ...snapshot(), ok: false, msg: tr('srv.monitorOff') };
  const now = Date.now();
  if (!inflight && now - lastManual < S.minRefreshMs) return { ...snapshot(), throttled: true };
  lastManual = now;
  return tick();
}

const onUsage = (cb) => { bus.on('usage', cb); return () => bus.off('usage', cb); };
const onThreshold = (cb) => { bus.on('threshold', cb); return () => bus.off('threshold', cb); };

module.exports = { start, stop, refresh, snapshot, onUsage, onThreshold, parseClaude, _settings: S };
