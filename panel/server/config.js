'use strict';
// Panel configuration: everything comes from the environment (start.sh passes the values in production).
const path = require('path');

const HOME = process.env.HOME || '/root';
const CLAUDE_DIR = path.join(HOME, '.claude');
let PANEL_VERSION = '?';
try { PANEL_VERSION = require('../package.json').version; } catch { /* no package.json */ }

const cfg = {
  HOME,
  PANEL_VERSION,
  BUILD_TIME: (() => { try { return require('fs').readFileSync(path.join(__dirname, '..', 'BUILD_TIME'), 'utf8').trim(); } catch { return ''; } })(), // written in the Dockerfile
  CLAUDE_DIR,
  PORT: parseInt(process.env.PANEL_PORT || '7001', 10),
  BIND: process.env.PANEL_BIND || '127.0.0.1',
  PROJECTS_DIR: process.env.PROJECTS_DIR || path.join(HOME, 'projects'),
  CONFIG_FILE: process.env.PANEL_CONFIG || path.join(CLAUDE_DIR, 'panel.json'),
  RUN_DIR: path.join(CLAUDE_DIR, 'run'),                       // "<session>.running" / "<session>.resume" flags (claude-loop.sh)
  LOGS_DIR: path.join(CLAUDE_DIR, 'logs'),
  SECRET_FILE: process.env.PANEL_SECRET_FILE || path.join(CLAUDE_DIR, '.panel-secret'),
  SESSIONS_FILE: path.join(CLAUDE_DIR, '.panel-sessions.json'),
  TOTP_FILE: path.join(CLAUDE_DIR, '.panel-totp.json'),
  HUB_FILE: path.join(CLAUDE_DIR, '.panel-hub.json'),               // remote hub people (sha256 keys) + their links, server/hub.js
  HUB_NAME: process.env.HUB_NAME || '',                              // name of this server on the hub (default: hostname)
  CHAT_KEYS_FILE: path.join(CLAUDE_DIR, '.panel-chat-keys.json'),     // chat link keys (sha256 only), server/chat.js
  AUDIT_LOG: path.join(CLAUDE_DIR, 'logs', 'audit.log'),
  CONFIG_BACKUP_DIR: path.join(HOME, '.claude-backups'),
  // extra Claude accounts (server/accounts.js): one config dir each, used as CLAUDE_CONFIG_DIR.
  // Same path as ACCOUNTS_DIR in devbox-lib.sh. The registry (ids + labels) is a panel state file.
  ACCOUNTS_DIR: path.join(HOME, '.claude-accounts'),
  ACCOUNTS_FILE: path.join(CLAUDE_DIR, '.panel-accounts.json'),
  DEVBOX_LIB: process.env.DEVBOX_LIB || '/usr/local/lib/devbox/lib.sh',
  SESSION_SCRIPT: process.env.SESSION_SCRIPT || '/usr/local/bin/claude-session.sh',
  BACKUP_SCRIPT: process.env.BACKUP_SCRIPT || '/usr/local/bin/backup.sh',
  REMOTE_CONTROL_NAME: process.env.REMOTE_CONTROL_NAME || '',  // empty -> remote uses the project name
  DIST: path.join(__dirname, '..', 'dist'),
  PANEL_LOGIN: process.env.PANEL_LOGIN || 'admin',
  PANEL_PASSWORD: process.env.PANEL_PASSWORD || '',
  SESSION_DAYS: Math.max(1, parseInt(process.env.PANEL_SESSION_DAYS || '365', 10) || 365),
  SHELL_SESSION: 'cr-shell',                                   // "shell in /root" tmux session
  FS_BASE: HOME,                                               // sandbox of the file manager
  WATCH_INTERVAL_MS: 2000,                                     // activity/state watcher (SSE)
  // environment variables shown on the Settings page (sensitive ones come out masked)
  ENV_SHOWN: ['PROJECT_FOLDER', 'PROJECTS_DIR', 'REMOTE_CONTROL_NAME', 'CLAUDE_AUTOCMD_DELAY', 'GH_TOKEN',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'BACKUP_ENABLED', 'BACKUP_INTERVAL', 'PANEL_ENABLED', 'GATEWAY_PORT',
    'PANEL_LOGIN', 'PANEL_PASSWORD', 'PANEL_SESSION_DAYS', 'TZ', 'DEPLOY_WEBHOOK_URL'],
  ENV_SECRET: ['GH_TOKEN', 'PANEL_PASSWORD', 'ANTHROPIC_API_KEY', 'DEPLOY_WEBHOOK_URL'],
};

module.exports = cfg;
