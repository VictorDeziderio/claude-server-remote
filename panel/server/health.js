'use strict';
// Saude do host: disco, memoria, load, uptime, versoes (Claude Code atual x ultima no npm),
// e atualizacao do Claude Code (npm i -g, via sudo sem senha do usuario ubuntu).
const fs = require('fs');
const os = require('os');
const cfg = require('./config');
const { sh, log } = require('./util');
const claude = require('./claude');

let latestCache = { t: 0, v: '' };
async function latestClaude() {
  if (latestCache.v && Date.now() - latestCache.t < 3600 * 1000) return latestCache.v;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = await sh(npm, ['view', '@anthropic-ai/claude-code', 'version'], { timeout: 15000, shell: process.platform === 'win32' });
  const v = r.ok ? r.stdout.trim() : '';
  if (v) latestCache = { t: Date.now(), v };
  return v;
}

async function diskOf(p) {
  const r = await sh('df', ['-kP', p]);
  if (!r.ok) return null;
  const line = r.stdout.trim().split('\n').pop() || '';
  const cols = line.split(/\s+/);
  if (cols.length < 5) return null;
  const total = parseInt(cols[1], 10) * 1024, used = parseInt(cols[2], 10) * 1024, avail = parseInt(cols[3], 10) * 1024;
  return { total, used, avail, pct: total ? Math.round((used / total) * 100) : 0 };
}
function memInfo() {
  // /proc/meminfo da "disponivel" de verdade (os.freemem ignora cache)
  try {
    const t = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => parseInt((t.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')) || [])[1] || '0', 10) * 1024;
    const total = get('MemTotal'), avail = get('MemAvailable');
    return { total, used: total - avail, avail, pct: total ? Math.round(((total - avail) / total) * 100) : 0 };
  } catch {
    const total = os.totalmem(), free = os.freemem();
    return { total, used: total - free, avail: free, pct: total ? Math.round(((total - free) / total) * 100) : 0 };
  }
}
async function health() {
  const [disk, current, latest, tmux] = await Promise.all([
    diskOf(cfg.HOME), claude.claudeVersion(), latestClaude(), sh('tmux', ['list-sessions', '-F', '#S']),
  ]);
  const curNum = (current.match(/\d+\.\d+\.\d+/) || [])[0] || '';
  return {
    ok: true,
    disk, mem: memInfo(),
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    cpus: os.cpus().length,
    uptime: os.uptime(),
    hostname: os.hostname(),
    node: process.version,
    claude: { current, currentNum: curNum, latest, updateAvailable: !!(latest && curNum && latest !== curNum) },
    tmuxSessions: tmux.ok ? tmux.stdout.trim().split('\n').filter(Boolean) : [],
    panel: { pid: process.pid, uptime: Math.round(process.uptime()), rss: process.memoryUsage().rss },
  };
}

let updating = null; // promise em andamento
async function updateClaude() {
  if (updating) return { ok: false, msg: 'atualizacao ja em andamento' };
  updating = (async () => {
    log('info', 'atualizando Claude Code');
    // npm global e do root -> sudo -n (NOPASSWD no Dockerfile). Timeout generoso (baixa o pacote).
    const r = await sh('sudo', ['-n', 'npm', 'install', '-g', '@anthropic-ai/claude-code@latest'], { timeout: 5 * 60 * 1000 });
    claude.resetVersionCache();
    latestCache = { t: 0, v: '' };
    const v = await claude.claudeVersion();
    // desde a 2.1.28x o `claude` e um binario nativo (dependencia opcional): se o download dele
    // falhou, o npm "passa" mas o claude nao roda -> reprova em vez de dizer "atualizado"
    if (r.ok && !/\d+\.\d+\.\d+/.test(v)) {
      return { ok: false, msg: 'npm instalou, mas o binario nativo do Claude Code nao veio (download falhou) — clique em Atualizar de novo', output: (r.stdout + r.stderr).slice(-2000) };
    }
    return r.ok
      ? { ok: true, msg: `Claude Code atualizado: ${v}. As sessoes em execucao continuam na versao antiga ate reiniciar.`, output: (r.stdout + r.stderr).slice(-2000) }
      : { ok: false, msg: 'falha ao atualizar: ' + (r.stderr || '').slice(-500), output: (r.stdout + r.stderr).slice(-2000) };
  })();
  try { return await updating; } finally { updating = null; }
}

module.exports = { health, updateClaude };
