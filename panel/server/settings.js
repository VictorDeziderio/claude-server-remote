'use strict';
// Configuracoes do painel: defaults do panel.json (autoStartClaude/autoRemote), preferencias
// (settings.*) e visualizacao das variaveis de ambiente (sensiveis mascaradas).
const cfg = require('./config');
const { truthy } = require('./util');
const projects = require('./projects');
const totp = require('./totp');

const mask = (v) => (!v ? '' : v.length <= 6 ? '••••' : v.slice(0, 2) + '••••' + v.slice(-2));

function getSettings() {
  const c = projects.loadConfig();
  const env = cfg.ENV_SHOWN.map((k) => ({
    key: k, value: cfg.ENV_SECRET.includes(k) ? mask(process.env[k] || '') : (process.env[k] ?? ''), secret: cfg.ENV_SECRET.includes(k), set: process.env[k] != null && process.env[k] !== '',
  }));
  return {
    ok: true,
    defaults: c.defaults,
    settings: { notifications: true, notifyDone: true, notifyPrompt: true, ...(c.settings || {}) },
    env,
    paths: { home: cfg.HOME, projectsDir: cfg.PROJECTS_DIR, configFile: cfg.CONFIG_FILE, logsDir: cfg.LOGS_DIR, backupDir: cfg.CONFIG_BACKUP_DIR },
    twofa: totp.status(),
    sessionDays: cfg.SESSION_DAYS,
  };
}
function setDefaults(patch) {
  const c = projects.loadConfig();
  for (const k of ['autoStartClaude', 'autoRemote']) if (patch && k in patch) c.defaults[k] = truthy(patch[k]);
  return projects.saveConfig(c) ? { ok: true, msg: 'defaults salvos (valem p/ projetos sem config propria, na proxima recriacao da sessao)', defaults: c.defaults } : { ok: false, msg: 'falha ao salvar' };
}
function setSettings(patch) {
  const c = projects.loadConfig();
  c.settings = c.settings || {};
  for (const k of ['notifications', 'notifyDone', 'notifyPrompt']) if (patch && k in patch) c.settings[k] = truthy(patch[k]);
  return projects.saveConfig(c) ? { ok: true, msg: 'preferencias salvas', settings: c.settings } : { ok: false, msg: 'falha ao salvar' };
}

module.exports = { getSettings, setDefaults, setSettings };
