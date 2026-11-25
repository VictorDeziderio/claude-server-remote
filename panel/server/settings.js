'use strict';
const { tr } = require('./i18n');
// Panel settings: panel.json defaults (autoStartClaude/autoRemote), preferences
// (settings.*) and a view of the environment variables (sensitive ones masked).
const cfg = require('./config');
const { truthy } = require('./util');
const projects = require('./projects');
const totp = require('./totp');

// found by @security: showing the first/last 2 characters (e.g. PANEL_PASSWORD, GH_TOKEN)
// still leaks part of the secret (and its length). FIXED placeholder — no real character, no
// hint of the length; `set` already says whether it is configured or not.
const mask = (v) => (v ? '••••••••' : '');

function getSettings() {
  const c = projects.loadConfig();
  const env = cfg.ENV_SHOWN.map((k) => ({
    key: k, value: cfg.ENV_SECRET.includes(k) ? mask(process.env[k] || '') : (process.env[k] ?? ''), secret: cfg.ENV_SECRET.includes(k), set: process.env[k] != null && process.env[k] !== '',
  }));
  return {
    ok: true,
    defaults: c.defaults,
    settings: { notifications: true, notifyDone: true, notifyPrompt: true, autoResume: true, ...(c.settings || {}) },
    env,
    paths: { home: cfg.HOME, projectsDir: cfg.PROJECTS_DIR, configFile: cfg.CONFIG_FILE, logsDir: cfg.LOGS_DIR, backupDir: cfg.CONFIG_BACKUP_DIR },
    twofa: totp.status(),
    sessionDays: cfg.SESSION_DAYS,
  };
}
function setDefaults(patch) {
  const c = projects.loadConfig();
  for (const k of ['autoStartClaude', 'autoRemote']) if (patch && k in patch) c.defaults[k] = truthy(patch[k]);
  return projects.saveConfig(c) ? { ok: true, msg: tr('srv.defaultsSaved'), defaults: c.defaults } : { ok: false, msg: tr('srv.saveFailed') };
}
function setSettings(patch) {
  const c = projects.loadConfig();
  c.settings = c.settings || {};
  for (const k of ['notifications', 'notifyDone', 'notifyPrompt', 'autoResume']) if (patch && k in patch) c.settings[k] = truthy(patch[k]);
  return projects.saveConfig(c) ? { ok: true, msg: tr('srv.prefsSaved'), settings: c.settings } : { ok: false, msg: tr('srv.saveFailed') };
}

module.exports = { getSettings, setDefaults, setSettings };
