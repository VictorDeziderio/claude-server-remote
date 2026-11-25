'use strict';
const { tr } = require('./i18n');
// Saude do host: disco, memoria, load, uptime, versoes (Claude Code atual x ultima no npm),
// e atualizacao do Claude Code (npm i -g, via sudo sem senha do usuario ubuntu). Tem tambem o
// sampler de 60s (CPU/memoria/alertas) — ver o fim do arquivo.
const fs = require('fs');
const os = require('os');
const cfg = require('./config');
const { sh, log } = require('./util');
const claude = require('./claude');
const alerts = require('./alerts');

let latestCache = { t: 0, v: '' };
let latestInflight = null; // achado @perf 2026-10-09: varias abas/componentes podem cair aqui
// com o cache vencido ao mesmo tempo (1x/hora) — sem isso, cada um dispara seu proprio `npm view`
async function latestClaude() {
  if (latestCache.v && Date.now() - latestCache.t < 3600 * 1000) return latestCache.v;
  if (latestInflight) return latestInflight;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  latestInflight = (async () => {
    const r = await sh(npm, ['view', '@anthropic-ai/claude-code', 'version'], { timeout: 15000, shell: process.platform === 'win32' });
    const v = r.ok ? r.stdout.trim() : '';
    if (v) latestCache = { t: Date.now(), v };
    return v;
  })();
  try { return await latestInflight; } finally { latestInflight = null; }
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
  const [disk, current, latest, tmux, top] = await Promise.all([
    diskOf(cfg.HOME), claude.claudeVersion(), latestClaude(), sh('tmux', ['list-sessions', '-F', '#S']), topProcesses(),
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
    cpu: { pct: lastCpuPct, cores: os.cpus().length },
    cgroupMem: cgroupMem(),
    top,
    history: ring.slice(),
  };
}

// ---------- sampler de 60s: CPU/memoria (ring de 6h) + alertas + disco>90% ----------
// CPU em % via delta de /proc/stat entre amostras (os.cpus() da snapshot, nao taxa). So o
// sampler chama isso (nunca health(), que e' sob demanda): um delta precisa de DUAS leituras
// espacadas — chamar ad-hoc desalinharia o estado usado pelo proprio sampler.
function readProcStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (n[3] || 0) + (n[4] || 0);
    const total = n.reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  } catch { return null; }
}
let prevStat = readProcStat();
let lastCpuPct = 0;
function sampleCpuPct() {
  const cur = readProcStat();
  if (!prevStat || !cur) { prevStat = cur; return; }
  const dTotal = cur.total - prevStat.total, dIdle = cur.idle - prevStat.idle;
  prevStat = cur;
  if (dTotal > 0) lastCpuPct = Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10; // 1 casa decimal
}
// cgroup v2 (memory.current/memory.max); ausente (cgroup v1, ou fora de container) -> null
function cgroupMem() {
  try {
    const cur = parseInt(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim(), 10);
    if (!Number.isFinite(cur)) return null;
    const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const max = raw === 'max' ? null : parseInt(raw, 10);
    return { current: cur, max: Number.isFinite(max) ? max : null, pct: Number.isFinite(max) && max > 0 ? Math.round((cur / max) * 100) : null };
  } catch { return null; }
}
// top 5 por %CPU. So `comm` (nome do executavel) — NUNCA args/command completo (pode conter
// segredos passados por linha de comando).
async function topProcesses() {
  const r = await sh('ps', ['-eo', 'pid,pcpu,rss,comm', '--sort=-pcpu']);
  if (!r.ok) return [];
  return r.stdout.trim().split('\n').slice(1, 6).map((l) => {
    const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!m) return null;
    return { pid: parseInt(m[1], 10), pcpu: parseFloat(m[2]), rss: parseInt(m[3], 10) * 1024, comm: m[4].trim() }; // ps da rss em KB; contrato quer bytes
  }).filter(Boolean);
}
const RING_MAX = 360; // 6h a 60s
const ring = [];
async function sample() {
  sampleCpuPct();
  const mem = memInfo();
  ring.push({ t: Date.now(), cpu: lastCpuPct, mem: mem.pct });
  if (ring.length > RING_MAX) ring.shift();
  alerts.poll(); // o arquivo de alertas so e lido aqui (60s), nunca no tick do watcher (2s)
  const disk = await diskOf(cfg.HOME);
  if (disk) alerts.maybeDiskAlert(disk.pct);
}
setInterval(() => { sample().catch((e) => log('error', 'health sampler', { err: e.message })); }, 60000).unref();
sample().catch(() => { /* 1a amostra: so popula o ring, sem alarme se falhar */ });

let updating = null; // promise em andamento
async function updateClaude() {
  if (updating) return { ok: false, msg: tr('srv.updateRunning') };
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
      return { ok: false, msg: tr('srv.npmNoBinary'), output: (r.stdout + r.stderr).slice(-2000) };
    }
    return r.ok
      ? { ok: true, msg: tr('srv.updated', { v }), output: (r.stdout + r.stderr).slice(-2000) }
      : { ok: false, msg: tr('srv.updateFailed') + (r.stderr || '').slice(-500), output: (r.stdout + r.stderr).slice(-2000) };
  })();
  try { return await updating; } finally { updating = null; }
}

module.exports = { health, updateClaude };
