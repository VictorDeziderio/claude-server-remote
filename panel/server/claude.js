'use strict';
// Estado da conta/instalacao do Claude Code: login, conta, versao, logout.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sh } = require('./util');

// Login + conta: le oauthAccount de ~/.claude.json (ou API key via env).
function loginInfo() {
  if (process.env.ANTHROPIC_API_KEY) return { logged: true, account: 'API key (env)', org: '', method: 'apikey' };
  let account = '', org = '', raw = '';
  try { raw = fs.readFileSync(path.join(cfg.HOME, '.claude.json'), 'utf8'); } catch { /* sem arquivo */ }
  if (raw) {
    try {
      const oa = JSON.parse(raw).oauthAccount;
      if (oa) { account = oa.emailAddress || oa.email || ''; org = oa.organizationName || ''; }
    } catch { /* json invalido */ }
  }
  let logged = !!account;
  try { if (fs.statSync(path.join(cfg.HOME, '.claude', '.credentials.json')).size > 0) logged = true; } catch { /* */ }
  if (!logged && raw && /"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"/.test(raw)) logged = true;
  return { logged, account, org, method: logged ? 'oauth' : '' };
}

// desloga o Claude: remove o token OAuth (.credentials.json) e o cache de conta (oauthAccount)
function claudeLogout() {
  let did = false;
  try { fs.rmSync(path.join(cfg.HOME, '.claude', '.credentials.json'), { force: true }); did = true; } catch { /* */ }
  try {
    const p = path.join(cfg.HOME, '.claude.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j && j.oauthAccount) { delete j.oauthAccount; fs.writeFileSync(p, JSON.stringify(j, null, 2)); did = true; }
  } catch { /* */ }
  return { ok: true, msg: did ? 'deslogado do Claude (credenciais removidas)' : 'nenhuma credencial encontrada' };
}

// versao e estavel em runtime -> resolve uma vez e cacheia (evita spawn por request)
let verCache = '';
async function claudeVersion() {
  if (verCache) return verCache;
  const v = ((await sh('claude', ['--version'])).stdout || '').trim().split('\n')[0];
  if (v) verCache = v;
  return v || '?';
}

module.exports = { loginInfo, claudeLogout, claudeVersion };
