'use strict';
// State of the Claude Code account/install: login, account, version, logout.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sh } = require('./util');

const accounts = require('./accounts');

// Login + account of a Claude account ('default' = ~/.claude + ~/.claude.json; others =
// ~/.claude-accounts/<id>, see server/accounts.js): oauthAccount from its .claude.json, the OAuth
// credentials file, a pasted long-lived token — or an API key via env (applies to every account).
function loginInfo(id = accounts.DEFAULT) {
  if (process.env.ANTHROPIC_API_KEY) return { logged: true, account: 'API key (env)', org: '', method: 'apikey', plan: '' };
  if (!accounts.exists(id)) return { logged: false, account: '', org: '', method: '', plan: '' };
  let account = '', org = '', raw = '', plan = '';
  try { raw = fs.readFileSync(accounts.claudeJsonOf(id), 'utf8'); } catch { /* no file */ }
  if (raw) {
    try {
      const oa = JSON.parse(raw).oauthAccount;
      if (oa) { account = oa.emailAddress || oa.email || ''; org = oa.organizationName || ''; }
    } catch { /* json invalido */ }
  }
  let logged = !!account, method = '';
  try {
    const c = fs.readFileSync(accounts.credFileOf(id), 'utf8');
    if (c.length > 0) logged = true;
    try { plan = String((JSON.parse(c).claudeAiOauth || {}).subscriptionType || ''); } catch { /* not json */ }
  } catch { /* */ }
  if (!logged && raw && /"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"/.test(raw)) logged = true;
  if (logged) method = 'oauth';
  else if (accounts.hasToken(id)) { logged = true; method = 'token'; }
  return { logged, account, org, method, plan };
}

// logs a Claude account out: OAuth token (.credentials.json), account cache (oauthAccount), pasted token
function claudeLogout(id = accounts.DEFAULT) { return accounts.logout(id); }

// the version is stable at runtime -> resolve once and cache it (avoids a spawn per request)
let verCache = '';
async function claudeVersion() {
  if (verCache) return verCache;
  const v = ((await sh('claude', ['--version'])).stdout || '').trim().split('\n')[0];
  if (v) verCache = v;
  return v || '?';
}
const resetVersionCache = () => { verCache = ''; };

module.exports = { loginInfo, claudeLogout, claudeVersion, resetVersionCache };
