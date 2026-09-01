'use strict';
// Configuracao do painel: tudo vem do ambiente (start.sh passa os valores em producao).
const path = require('path');

const HOME = process.env.HOME || '/root';
const CLAUDE_DIR = path.join(HOME, '.claude');

const cfg = {
  HOME,
  CLAUDE_DIR,
  PORT: parseInt(process.env.PANEL_PORT || '7001', 10),
  BIND: process.env.PANEL_BIND || '127.0.0.1',
  PROJECTS_DIR: process.env.PROJECTS_DIR || path.join(HOME, 'projects'),
  CONFIG_FILE: process.env.PANEL_CONFIG || path.join(CLAUDE_DIR, 'panel.json'),
  RUN_DIR: path.join(CLAUDE_DIR, 'run'),                       // flags "<sessao>.running" / "<sessao>.resume" (claude-loop.sh)
  LOGS_DIR: path.join(CLAUDE_DIR, 'logs'),
  SECRET_FILE: process.env.PANEL_SECRET_FILE || path.join(CLAUDE_DIR, '.panel-secret'),
  SESSIONS_FILE: path.join(CLAUDE_DIR, '.panel-sessions.json'),
  TOTP_FILE: path.join(CLAUDE_DIR, '.panel-totp.json'),
  AUDIT_LOG: path.join(CLAUDE_DIR, 'logs', 'audit.log'),
  CONFIG_BACKUP_DIR: path.join(HOME, '.claude-backups'),
  SESSION_SCRIPT: process.env.SESSION_SCRIPT || '/usr/local/bin/claude-session.sh',
  BACKUP_SCRIPT: process.env.BACKUP_SCRIPT || '/usr/local/bin/backup.sh',
  REMOTE_CONTROL_NAME: process.env.REMOTE_CONTROL_NAME || '',  // vazio -> remote usa o nome do projeto
  DIST: path.join(__dirname, '..', 'dist'),
  PANEL_LOGIN: process.env.PANEL_LOGIN || 'admin',
  PANEL_PASSWORD: process.env.PANEL_PASSWORD || '',
  SESSION_DAYS: Math.max(1, parseInt(process.env.PANEL_SESSION_DAYS || '30', 10) || 30),
  SHELL_SESSION: 'cr-shell',                                   // sessao tmux "shell em /root"
  FS_BASE: HOME,                                               // sandbox do gerenciador de arquivos
  WATCH_INTERVAL_MS: 2000,                                     // watcher de atividade/estado (SSE)
  // variaveis de ambiente exibidas na pagina Configuracoes (as sensiveis saem mascaradas)
  ENV_SHOWN: ['PROJECT_FOLDER', 'PROJECTS_DIR', 'REMOTE_CONTROL_NAME', 'CLAUDE_AUTOCMD_DELAY', 'GH_TOKEN',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'BACKUP_ENABLED', 'BACKUP_INTERVAL', 'PANEL_ENABLED', 'GATEWAY_PORT',
    'PANEL_LOGIN', 'PANEL_PASSWORD', 'PANEL_SESSION_DAYS', 'TZ'],
  ENV_SECRET: ['GH_TOKEN', 'PANEL_PASSWORD', 'ANTHROPIC_API_KEY'],
};

module.exports = cfg;
