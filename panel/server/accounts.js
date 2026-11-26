'use strict';
const { tr } = require('./i18n');
/*
 * Claude accounts — several logins on the same box, chosen PER PROJECT and switched by hand
 * (never rotated automatically). Account page lists them; Configure -> Account picks one.
 *
 *   "default"  the usual login: ~/.claude + ~/.claude.json. Claude runs WITHOUT CLAUDE_CONFIG_DIR,
 *              so installs from before this feature keep working with zero migration.
 *   <id>       its own config dir ~/.claude-accounts/<id>, given to Claude as CLAUDE_CONFIG_DIR
 *              (claude-loop.sh / claude-session.sh / the login session). Claude Code 2.1.x keeps
 *              there .credentials.json and .claude.json (oauthAccount, onboarding and trust flags)
 *              and reads projects/, settings.json, skills/... from it (checked with
 *              `claude auth status --json`: configDirectory/projectsDirectory follow the variable).
 *
 * Only the LOGIN is per account. Everything else is a symlink to the default ~/.claude entry
 * (account_prepare in devbox-lib.sh — the single list of shared entries), so a project that switches
 * account keeps its conversations (--continue/--resume), the History/chat/auto-resume readers keep
 * reading ~/.claude/projects, and settings/skills/plugins stay the same. The managed settings
 * (/etc/claude-code/managed-settings.json: permissions + the panel hooks) are system-wide and apply
 * to every account.
 *
 * A long-lived token (`claude setup-token`, generated anywhere) can be pasted per account: stored in
 * <account dir>/.oauth-token (0600), exported as CLAUDE_CODE_OAUTH_TOKEN for that account's sessions.
 * Tokens are never logged, audited or sent back to the browser.
 *
 * Registry: cfg.ACCOUNTS_FILE (0600) = { defaultLabel, accounts: [{ id, label, createdAt }] }.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { sh, log } = require('./util');

const DEFAULT = 'default';
const ID_RX = /^[a-z0-9][a-z0-9-]{0,39}$/; // same rule as valid_account (devbox-lib.sh)
const TOKEN_FILE = '.oauth-token'; // same name as ACCOUNT_TOKEN_FILE (devbox-lib.sh)
const TOKEN_RX = /^[A-Za-z0-9._~+/=-]{20,4096}$/;
const MAX_LABEL = 40;

// ---------- registry ----------
function loadReg() {
  try {
    const j = JSON.parse(fs.readFileSync(cfg.ACCOUNTS_FILE, 'utf8'));
    const accounts = (Array.isArray(j && j.accounts) ? j.accounts : [])
      .filter((a) => a && typeof a.id === 'string' && ID_RX.test(a.id) && a.id !== DEFAULT)
      .map((a) => ({ id: a.id, label: String(a.label || a.id).slice(0, MAX_LABEL), createdAt: Number(a.createdAt) || 0 }));
    return { defaultLabel: typeof j.defaultLabel === 'string' ? j.defaultLabel.slice(0, MAX_LABEL) : '', accounts };
  } catch { return { defaultLabel: '', accounts: [] }; }
}
function saveReg(r) {
  try {
    fs.mkdirSync(path.dirname(cfg.ACCOUNTS_FILE), { recursive: true });
    const tmp = cfg.ACCOUNTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, cfg.ACCOUNTS_FILE);
    return true;
  } catch (e) { log('error', 'accounts: save registry', { err: e.message }); return false; }
}

// ---------- paths ----------
const isDefault = (id) => !id || id === DEFAULT;
const exists = (id) => isDefault(id) || (ID_RX.test(String(id)) && loadReg().accounts.some((a) => a.id === id));
const dirOf = (id) => (isDefault(id) ? cfg.CLAUDE_DIR : path.join(cfg.ACCOUNTS_DIR, id));
const claudeJsonOf = (id) => (isDefault(id) ? path.join(cfg.HOME, '.claude.json') : path.join(dirOf(id), '.claude.json'));
const credFileOf = (id) => path.join(dirOf(id), '.credentials.json');
const tokenFileOf = (id) => path.join(dirOf(id), TOKEN_FILE);
// environment to run `claude` as this account ({} for the default one)
const envOf = (id) => (isDefault(id) ? {} : { CLAUDE_CONFIG_DIR: dirOf(id) });
function readToken(id) {
  try { return fs.readFileSync(tokenFileOf(id), 'utf8').split('\n')[0].trim(); } catch { return ''; }
}
const hasToken = (id) => !!readToken(id);

function list() {
  const r = loadReg();
  return [{ id: DEFAULT, label: r.defaultLabel, isDefault: true, createdAt: 0 }, ...r.accounts.map((a) => ({ ...a, isDefault: false }))];
}
const labelOf = (id) => { const a = list().find((x) => x.id === (id || DEFAULT)); return a ? a.label || (a.isDefault ? tr('acct.defaultLabel') : a.id) : String(id || DEFAULT); };

// accounts + login state, for /api/state (cheap: a few small file reads per account)
function summary() {
  const { loginInfo } = require('./claude'); // lazy: claude.js requires this module
  return list().map((a) => {
    const l = loginInfo(a.id);
    return { id: a.id, label: a.label, isDefault: a.isDefault, createdAt: a.createdAt, logged: l.logged, account: l.account, org: l.org, method: l.method, plan: l.plan || '' };
  });
}

// projects that use an account (panel.json `account`; none/unknown = the default account).
// Extra accounts also count entries of panel.json whose folder is gone (removing would orphan them).
function projectsUsing(id) {
  try {
    const c = require('./projects').loadConfig(); // lazy: projects.js requires this module
    const ids = new Set(loadReg().accounts.map((a) => a.id));
    const acctOf = (n) => { const a = c.projects && c.projects[n] && c.projects[n].account; return ids.has(a) ? a : DEFAULT; };
    if (isDefault(id)) return require('./projects-list').listProjects().filter((n) => acctOf(n) === DEFAULT);
    return Object.keys(c.projects || {}).filter((n) => acctOf(n) === id);
  } catch { return []; }
}

// symlinks of the shared entries (projects/, settings.json, skills/...) — devbox-lib.sh account_prepare
async function prepare(id) {
  if (isDefault(id)) return true;
  const r = await sh('bash', ['-c', '. "$1" && account_prepare "$2"', '_', cfg.DEVBOX_LIB, dirOf(id)]);
  if (!r.ok) log('warn', 'accounts: account_prepare failed', { id, err: (r.stderr || '').trim().slice(0, 200) });
  return r.ok;
}

// .claude.json of a new account = the default one MINUS the account identity and the caches tied
// to it: keeps onboarding/theme/trusted folders/MCP servers, so Claude does not ask everything again.
const DROP_KEY_RX = /^(oauthAccount|primaryApiKey|customApiKeyResponses|replBridgePlaceholders|remoteControlMachineId|claudeCodeFirstTokenDate|trainingConsentSettledAt|autoCompactOffer|s1mAccessCache)$|[Cc]ache|^passes|^grove/;
function seedClaudeJson(id) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(claudeJsonOf(DEFAULT), 'utf8')) || {}; } catch { /* no default config yet */ }
  const out = {};
  for (const [k, v] of Object.entries(j)) if (!DROP_KEY_RX.test(k)) out[k] = v;
  fs.writeFileSync(claudeJsonOf(id), JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
}

const cleanLabel = (s) => String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_LABEL);
function newId(label) {
  const slug = label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'account';
  return `${slug}-${crypto.randomBytes(2).toString('hex')}`;
}

// ---------- actions ----------
async function create(labelIn) {
  const label = cleanLabel(labelIn);
  if (!label) return { ok: false, msg: tr('srv.acct.badLabel') };
  const r = loadReg();
  if (r.accounts.length >= 20) return { ok: false, msg: tr('srv.acct.tooMany') };
  let id = newId(label);
  while (r.accounts.some((a) => a.id === id) || id === DEFAULT) id = newId(label);
  const dir = dirOf(id);
  try {
    fs.mkdirSync(cfg.ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 });
    seedClaudeJson(id);
  } catch (e) { return { ok: false, msg: tr('srv.failed') + e.message }; }
  await prepare(id);
  r.accounts.push({ id, label, createdAt: Date.now() });
  if (!saveReg(r)) return { ok: false, msg: tr('srv.saveConfigFailed') };
  log('info', 'accounts: created', { id });
  bump();
  return { ok: true, id, msg: tr('srv.acct.created', { label }) };
}

function rename(id, labelIn) {
  const label = cleanLabel(labelIn);
  if (!label) return { ok: false, msg: tr('srv.acct.badLabel') };
  if (!exists(id)) return { ok: false, msg: tr('srv.acct.none') };
  const r = loadReg();
  if (isDefault(id)) r.defaultLabel = label;
  else r.accounts.find((a) => a.id === id).label = label;
  if (!saveReg(r)) return { ok: false, msg: tr('srv.saveConfigFailed') };
  bump();
  return { ok: true, msg: tr('srv.acct.renamed', { label }) };
}

async function remove(id) {
  if (isDefault(id)) return { ok: false, msg: tr('srv.acct.noRemoveDefault') };
  if (!exists(id)) return { ok: false, msg: tr('srv.acct.none') };
  const used = projectsUsing(id);
  if (used.length) return { ok: false, msg: tr('srv.acct.inUse', { names: used.join(', ') }) };
  try { if (require('./login').status().account === id) await require('./login').cancel(); } catch { /* */ }
  const dir = dirOf(id);
  // only ever inside ACCOUNTS_DIR; rmSync does not follow the shared symlinks (the links go, ~/.claude stays)
  if (path.dirname(dir) !== cfg.ACCOUNTS_DIR) return { ok: false, msg: tr('srv.acct.none') };
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, msg: tr('srv.failed') + e.message }; }
  const r = loadReg();
  r.accounts = r.accounts.filter((a) => a.id !== id);
  saveReg(r);
  log('info', 'accounts: removed', { id });
  bump();
  return { ok: true, msg: tr('srv.acct.removed') };
}

// logs one account out: OAuth credentials, the cached oauthAccount and a pasted token
function logout(id) {
  if (!exists(id)) return { ok: false, msg: tr('srv.acct.none') };
  let did = false;
  try { if (fs.existsSync(credFileOf(id))) { fs.rmSync(credFileOf(id), { force: true }); did = true; } } catch { /* */ }
  try { if (fs.existsSync(tokenFileOf(id))) { fs.rmSync(tokenFileOf(id), { force: true }); did = true; } } catch { /* */ }
  try {
    const p = claudeJsonOf(id);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.oauthAccount) { delete j.oauthAccount; fs.writeFileSync(p, JSON.stringify(j, null, 2)); did = true; }
  } catch { /* */ }
  bump();
  return { ok: true, msg: did ? tr('srv.acct.loggedOut') : tr('srv.acct.nothingToLogout') };
}

// long-lived token (claude setup-token): '' removes it. Applies on the next Claude start of the
// projects on this account (Restart in the panel).
function setToken(id, tokenIn) {
  if (!exists(id)) return { ok: false, msg: tr('srv.acct.none') };
  const token = String(tokenIn == null ? '' : tokenIn).trim();
  const f = tokenFileOf(id);
  if (!token) {
    try { fs.rmSync(f, { force: true }); } catch { /* */ }
    bump();
    return { ok: true, msg: tr('srv.acct.tokenRemoved') };
  }
  if (!TOKEN_RX.test(token)) return { ok: false, msg: tr('srv.acct.badToken') };
  try {
    fs.mkdirSync(dirOf(id), { recursive: true, mode: 0o700 });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, f);
  } catch (e) { return { ok: false, msg: tr('srv.failed') + e.message }; }
  bump();
  return { ok: true, msg: tr('srv.acct.tokenSaved') };
}

// state changed -> the dashboard (SSE) and the limits poller see it soon
function bump() {
  try { require('./events').poke(); } catch { /* */ }
}

module.exports = {
  DEFAULT, ID_RX, list, summary, labelOf, exists, isDefault, dirOf, claudeJsonOf, credFileOf, tokenFileOf, envOf,
  readToken, hasToken, projectsUsing, prepare, create, rename, remove, logout, setToken, _loadReg: loadReg,
};
