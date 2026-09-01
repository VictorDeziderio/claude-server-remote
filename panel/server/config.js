'use strict';
// Configuracao do painel: tudo vem do ambiente (start.sh passa os valores em producao).
const path = require('path');

const HOME = process.env.HOME || '/root';

const cfg = {
  HOME,
  PORT: parseInt(process.env.PANEL_PORT || '7001', 10),
  BIND: process.env.PANEL_BIND || '127.0.0.1',
  PROJECTS_DIR: process.env.PROJECTS_DIR || path.join(HOME, 'projects'),
  CONFIG_FILE: process.env.PANEL_CONFIG || path.join(HOME, '.claude', 'panel.json'),
  RUN_DIR: path.join(HOME, '.claude', 'run'),                 // flags "<sessao>.running" (claude-loop.sh)
  SECRET_FILE: process.env.PANEL_SECRET_FILE || path.join(HOME, '.claude', '.panel-secret'),
  SESSION_SCRIPT: process.env.SESSION_SCRIPT || '/usr/local/bin/claude-session.sh',
  REMOTE_CONTROL_NAME: process.env.REMOTE_CONTROL_NAME || '',  // vazio -> remote usa o nome do projeto
  DIST: path.join(__dirname, '..', 'dist'),
  PANEL_LOGIN: process.env.PANEL_LOGIN || 'admin',
  PANEL_PASSWORD: process.env.PANEL_PASSWORD || '',
  SESSION_DAYS: Math.max(1, parseInt(process.env.PANEL_SESSION_DAYS || '30', 10) || 30),
  SHELL_SESSION: 'cr-shell',                                   // sessao tmux "shell em /root"
  FS_BASE: HOME,                                               // sandbox do gerenciador de arquivos
};

module.exports = cfg;
