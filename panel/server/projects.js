'use strict';
// Projetos: config (panel.json), sessoes tmux por projeto, acoes (criar/renomear/excluir/
// reiniciar/remote/primeira linha) e o estado consolidado do dashboard.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sh, validName, sessionName, paneOf, truthy, log } = require('./util');
const { listProjects } = require('./projects-list');
const { loginInfo, claudeVersion } = require('./claude');
const events = require('./events');
const history = require('./history'); // seguro no topo: history.js so pede ./projects LAZY (dentro de uma funcao)

const remoteCmdFor = (name) => '/remote-control ' + (cfg.REMOTE_CONTROL_NAME || name);

// ---------- config (panel.json) ----------
// enabled: projeto LIGADO (sessao sobe no boot e o watchdog a mantem) | autoStartClaude: a sessao
// roda o Claude | autoRemote: religa o /remote-control a cada inicio do Claude (claude-loop.sh)
const FLAGS = ['enabled', 'autoStartClaude', 'autoRemote'];
const DEFAULTS = { enabled: true, autoStartClaude: true, autoRemote: true, idlePauseHours: 0 };
const SESSION_MODES = new Set(['new', 'continue', 'pinned']);
const PINNED_ID_RX = /^[A-Za-z0-9_-]{6,80}$/;
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(cfg.CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object') { c.defaults = { ...DEFAULTS, ...(c.defaults || {}) }; c.projects = c.projects || {}; c.settings = c.settings || {}; return c; }
  } catch { /* ausente/invalido -> defaults */ }
  return { defaults: { ...DEFAULTS }, projects: {}, settings: {} };
}
function saveConfig(c) {
  try {
    fs.mkdirSync(path.dirname(cfg.CONFIG_FILE), { recursive: true });
    const tmp = cfg.CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
    fs.renameSync(tmp, cfg.CONFIG_FILE); // escrita atomica (o claude-session.sh le esse arquivo)
    return true;
  } catch (e) { log('error', 'erro salvando panel.json', { err: e.message }); return false; }
}
// mesma derivacao de projConfig, mas a partir de um `c` (loadConfig()) ja carregado — usado no
// buildState (hot path do watcher) p/ nao reler panel.json do disco uma vez por projeto a cada tick
function configFrom(c, name) {
  const d = c.defaults || {};
  const p = (c.projects && c.projects[name]) || {};
  // mesma regra do devbox-lib.sh (proj_config): so `false` explicito desliga
  const pick = (k) => (k in p ? p[k] !== false : (k in d ? d[k] !== false : true));
  const numOr = (v, fallback) => (typeof v === 'number' && v >= 0 ? v : fallback);
  return {
    enabled: pick('enabled'),
    autoStartClaude: pick('autoStartClaude'),
    autoRemote: pick('autoRemote'),
    initLine: typeof p.initLine === 'string' ? p.initLine : '', // "primeira linha" enviada ao Claude quando ele fica pronto
    // sessionMode: 'new' (comeca do zero) | 'continue' (claude --continue) | 'pinned' (--resume <id> fixo)
    sessionMode: SESSION_MODES.has(p.sessionMode) ? p.sessionMode : 'new',
    pinnedSession: typeof p.pinnedSession === 'string' ? p.pinnedSession : '',
    // 0 = off; override por projeto, senao o default do panel.json, senao 0
    idlePauseHours: numOr(p.idlePauseHours, numOr(d.idlePauseHours, 0)),
  };
}
function projConfig(name) { return configFrom(loadConfig(), name); }
function setProjConfig(name, patch) {
  const c = loadConfig();
  c.projects = c.projects || {};
  c.projects[name] = Object.assign({}, c.projects[name], patch);
  return saveConfig(c);
}

// ---------- sessao tmux ----------
const sessionUp = async (sess) => (await sh('tmux', ['has-session', '-t', '=' + sess])).ok;
// sobe a sessao do projeto SE ele estiver ligado (o script respeita enabled=false)
const ensureSession = (name) => sh('bash', [cfg.SESSION_SCRIPT, name]);
async function killSession(name) {
  const sess = sessionName(name);
  await sh('tmux', ['kill-session', '-t', '=' + sess]);
  try { fs.rmSync(path.join(cfg.RUN_DIR, sess + '.running'), { force: true }); } catch { /* */ }
}
// recria a sessao do zero (fecha remote + Claude) com a config atual.
// Trava com um sentinel em RUN_DIR (achado @qa 2026-09-28) so durante o kill: sem ele, o
// watchdog do start.sh (claude-session.sh --all, a cada 10s) podia enxergar a sessao ja
// morta e recria-la ANTES do ensureSession daqui rodar (corrida). O lock e' liberado ANTES
// do ensureSession (nao envolve a chamada inteira): ensureSession chama o MESMO
// claude-session.sh que respeita o lock, entao segura-lo durante o proprio ensureSession
// bloquearia o painel de recriar a sua propria sessao (deadlock — pego pelo smoke test).
async function recreateSession(name) {
  const sess = sessionName(name);
  const lock = path.join(cfg.RUN_DIR, sess + '.lock');
  try { fs.mkdirSync(cfg.RUN_DIR, { recursive: true }); fs.writeFileSync(lock, String(process.pid)); } catch { /* */ }
  try {
    await killSession(name);
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch { /* */ }
  }
  await ensureSession(name);
}
const projectExists = (name) => validName(name) && fs.existsSync(path.join(cfg.PROJECTS_DIR, name));
// Claude de fato rodando nessa sessao? flag file mantido pelo claude-loop.sh
function claudeRunningFlag(sess) {
  try { return fs.existsSync(path.join(cfg.RUN_DIR, sess + '.running')); } catch { return false; }
}
// pausado (manual ou por inatividade)? o claude-loop.sh nao reabre o Claude enquanto o flag existe
const pausedFlagPath = (sess) => path.join(cfg.RUN_DIR, sess + '.paused');
function pausedFlag(sess) {
  try { return fs.existsSync(pausedFlagPath(sess)); } catch { return false; }
}

// ---------- acoes ----------
async function createProject(name, autoStartClaude, autoRemote) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido (use letras, numeros, . _ -)' };
  const dir = path.join(cfg.PROJECTS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, msg: 'ja existe' };
  fs.mkdirSync(dir, { recursive: true });
  await sh('git', ['-C', dir, 'init', '-q']);
  setProjConfig(name, { enabled: true, autoStartClaude: !!autoStartClaude, autoRemote: !!autoRemote });
  await ensureSession(name);
  events.poke();
  return { ok: true, msg: `projeto "${name}" criado e sessao iniciada (Claude ${autoStartClaude ? 'ON' : 'OFF'}, remote ${autoRemote ? 'ON' : 'OFF'})` };
}
// Reiniciar = LIGA (se estava desligado) + mata a sessao inteira + recria do zero. O supervisor
// reabre o Claude, re-emite o remote-control e envia a primeira linha.
async function restartProject(name) {
  if (!projectExists(name)) return { ok: false, msg: 'projeto inexistente' };
  if (!projConfig(name).enabled && !setProjConfig(name, { enabled: true })) return { ok: false, msg: 'falha ao salvar panel.json' };
  await recreateSession(name);
  events.poke();
  const c = projConfig(name);
  if (!c.autoStartClaude) return { ok: true, msg: `"${name}": sessao reiniciada (so shell — Claude esta OFF)` };
  return { ok: true, msg: `"${name}": sessao reiniciada — Claude reaberto${c.autoRemote ? ', remote religado' : ''}${c.initLine ? ' e primeira linha enviada' : ''}` };
}
// Ligar/desligar o PROJETO. Desligado = sem sessao tmux, e continua assim no boot do container
// e no watchdog (antes o watchdog recriava tudo em ~10s e o "desligar" nao durava).
async function setPower(name, on) {
  if (!projectExists(name)) return { ok: false, msg: 'projeto inexistente' };
  const val = truthy(on);
  if (!setProjConfig(name, { enabled: val })) return { ok: false, msg: 'falha ao salvar panel.json' };
  if (val) await ensureSession(name);
  else await killSession(name);
  events.poke();
  return { ok: true, msg: val ? `"${name}": LIGADO — sessao iniciada` : `"${name}": DESLIGADO — sessao encerrada (nao volta no restart do container)` };
}
// Claude guarda o historico em ~/.claude/projects/<cwd codificado> (nao-alfanumerico -> "-").
function migrateClaudeHistory(oldDir, newDir) {
  try {
    const base = path.join(cfg.CLAUDE_DIR, 'projects');
    const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
    const from = path.join(base, enc(oldDir));
    const to = path.join(base, enc(newDir));
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.renameSync(from, to); return true; }
  } catch (e) { log('error', 'migrate hist', { err: e.message }); }
  return false;
}
async function renameProject(oldName, newName) {
  if (!validName(oldName) || !validName(newName)) return { ok: false, msg: 'nome invalido' };
  if (oldName === newName) return { ok: false, msg: 'o nome e o mesmo' };
  const oldDir = path.join(cfg.PROJECTS_DIR, oldName);
  const newDir = path.join(cfg.PROJECTS_DIR, newName);
  if (!fs.existsSync(oldDir)) return { ok: false, msg: 'pasta inexistente' };
  if (fs.existsSync(newDir)) return { ok: false, msg: `ja existe um projeto "${newName}"` };
  await killSession(oldName);
  try { fs.renameSync(oldDir, newDir); }
  catch (e) { return { ok: false, msg: 'falha ao renomear: ' + e.message }; }
  const histMoved = migrateClaudeHistory(oldDir, newDir);
  const c = loadConfig();
  if (c.projects && c.projects[oldName]) {
    c.projects[newName] = c.projects[oldName];
    delete c.projects[oldName];
    saveConfig(c);
  }
  await ensureSession(newName);
  events.poke();
  return { ok: true, msg: `"${oldName}" -> "${newName}"${histMoved ? ' (historico migrado)' : ''} (sessao recriada)` };
}
async function deleteProject(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const dir = path.join(cfg.PROJECTS_DIR, name);
  if (!fs.existsSync(dir)) return { ok: false, msg: 'pasta inexistente' };
  // lock durante kill + rm: sem ele o watchdog (a cada 10s) via a pasta ainda la e a sessao
  // morta e subia tudo de novo no meio da exclusao (bug do projeto "codigo", 2026-11-24)
  const lock = path.join(cfg.RUN_DIR, sessionName(name) + '.lock');
  try { fs.mkdirSync(cfg.RUN_DIR, { recursive: true }); fs.writeFileSync(lock, String(process.pid)); } catch { /* */ }
  try {
    await killSession(name);
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { return { ok: false, msg: 'falha ao excluir: ' + e.message }; }
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch { /* */ }
  }
  const c = loadConfig();
  if (c.projects && c.projects[name]) { delete c.projects[name]; saveConfig(c); }
  events.poke();
  return { ok: true, msg: `projeto "${name}" excluido (pasta + sessao). O historico do Claude foi mantido.` };
}
async function sendRemote(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const sess = sessionName(name);
  if (!(await sessionUp(sess))) return { ok: false, msg: 'sessao tmux nao esta de pe' };
  if (!loginInfo().logged) return { ok: false, msg: 'Claude nao esta logado' };
  // sem o Claude rodando o texto cairia no bash (ou num vim) da sessao
  if (!claudeRunningFlag(sess)) return { ok: false, msg: 'o Claude nao esta rodando nessa sessao' };
  const cmd = remoteCmdFor(name);
  // Mesmo metodo do claude-loop.sh: texto literal, pausa p/ a TUI processar, depois Enter (C-m).
  await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', cmd]);
  await new Promise((r) => setTimeout(r, 800));
  await sh('tmux', ['send-keys', '-t', paneOf(sess), 'C-m']);
  // Claude Code 2.1.28x+: pede confirmacao ("❯ 1. Enable Remote Control") -> Enter aceita
  // (Esc seria "Never mind"). Olha por ate ~8s.
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const c = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-S', '-40']);
    if (c.ok && /❯\s*1\.\s*Enable Remote Control/.test(c.stdout)) { await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Enter']); break; }
    if (c.ok && /claude\.ai\/code\//.test(c.stdout)) break;
  }
  // versoes anteriores abriam um dialogo ("> Continue · Esc to continue") que trava o prompt:
  // em ~10s, se ele estiver na tela, manda Esc p/ voltar ao prompt (o link continua valido)
  setTimeout(async () => {
    for (let i = 0; i < 5; i++) {
      const r = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-S', '-60']);
      if (!r.ok || !/Esc to continue|Disconnect this session|Show QR code/.test(r.stdout)) break;
      await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Escape']);
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    events.poke();
  }, 10000);
  events.poke();
  return { ok: true, msg: `remote reenviado: ${cmd} — o link aparece no card em alguns segundos` };
}
async function setConfig(name, key, value) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (key === 'enabled') return setPower(name, value);
  if (!FLAGS.includes(key)) return { ok: false, msg: 'chave invalida' };
  const val = truthy(value);
  if (!setProjConfig(name, { [key]: val })) return { ok: false, msg: 'falha ao salvar panel.json' };
  events.poke();
  if (key === 'autoStartClaude') {
    // aplica NA HORA: ON sobe o Claude, OFF encerra o Claude e deixa so o shell na pasta
    const c = projConfig(name);
    if (!c.enabled) return { ok: true, msg: `"${name}": Claude ${val ? 'ON' : 'OFF'} (projeto desligado — vale quando ligar)` };
    await recreateSession(name);
    events.poke();
    return { ok: true, msg: val ? `"${name}": Claude ON — iniciado` : `"${name}": Claude OFF — encerrado (sessao ficou so com o shell)` };
  }
  if (key === 'autoRemote') {
    if (val) {
      const r = await sendRemote(name);
      return {
        ok: true,
        msg: r.ok ? `"${name}": remote LIGADO e reenviado (${remoteCmdFor(name)})`
                  : `"${name}": remote LIGADO (sera enviado quando sessao/login estiver pronto)`,
      };
    }
    return { ok: true, msg: `"${name}": remote DESLIGADO (nao religa mais; o atual encerra ao reiniciar a sessao)` };
  }
  return { ok: true };
}
async function setInitLine(name, text) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const t = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').slice(0, 1000);
  if (!setProjConfig(name, { initLine: t })) return { ok: false, msg: 'falha ao salvar panel.json' };
  events.poke();
  return { ok: true, msg: t ? `"${name}": primeira linha salva (vale no proximo inicio do Claude)` : `"${name}": primeira linha removida` };
}
// modo de sessao: 'new' | 'continue' | 'pinned' (precisa de um id que exista no historico do projeto)
async function setSessionMode(name, mode, id) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (!projectExists(name)) return { ok: false, msg: 'projeto inexistente' };
  if (!SESSION_MODES.has(mode)) return { ok: false, msg: 'modo invalido (use new, continue ou pinned)' };
  let pinnedSession = '';
  if (mode === 'pinned') {
    if (!PINNED_ID_RX.test(String(id || ''))) return { ok: false, msg: 'id de conversa invalido' };
    const h = await history.listHistory(name);
    if (!h.ok || !h.sessions.some((s) => s.id === id)) return { ok: false, msg: 'conversa nao encontrada no historico desse projeto' };
    pinnedSession = id;
  }
  if (!setProjConfig(name, { sessionMode: mode, pinnedSession: mode === 'pinned' ? pinnedSession : undefined })) {
    return { ok: false, msg: 'falha ao salvar panel.json' };
  }
  events.poke();
  return { ok: true, msg: `"${name}": modo de sessao = ${mode}${mode === 'pinned' ? ` (${pinnedSession.slice(0, 8)}…)` : ''}` };
}
// pausa manual: grava o flag sempre; so manda /exit se o Claude estiver parado no prompt
// (nao interrompe trabalho em andamento) — o claude-loop.sh nao reabre enquanto o flag existir
async function pauseProject(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (!projectExists(name)) return { ok: false, msg: 'projeto inexistente' };
  const sess = sessionName(name);
  try {
    fs.mkdirSync(cfg.RUN_DIR, { recursive: true });
    fs.writeFileSync(pausedFlagPath(sess), 'manual');
  } catch (e) { return { ok: false, msg: 'falha ao gravar flag: ' + e.message }; }
  let exited = false;
  if (claudeRunningFlag(sess) && ['idle', 'prompt'].includes(events.activityOf(sess))) {
    await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', '/exit']);
    await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Enter']);
    exited = true;
  }
  events.poke();
  return { ok: true, msg: `"${name}": pausado${exited ? ' — /exit enviado' : ''} (o Claude nao reabre nessa sessao enquanto pausado)` };
}
function unpauseProject(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (!projectExists(name)) return { ok: false, msg: 'projeto inexistente' };
  const sess = sessionName(name);
  try { fs.rmSync(pausedFlagPath(sess), { force: true }); } catch (e) { return { ok: false, msg: e.message }; }
  events.poke();
  return { ok: true, msg: `"${name}": despausado` };
}

// ---------- estado consolidado (dashboard) ----------
async function buildState() {
  const names = listProjects();
  const conf = loadConfig();
  const projects = await Promise.all(names.map(async (name) => {
    const sess = sessionName(name);
    const up = await sessionUp(sess);
    const c = configFrom(conf, name);
    return {
      name,
      dir: path.join(cfg.PROJECTS_DIR, name),
      session: sess,
      up,
      claudeRunning: up && claudeRunningFlag(sess),
      enabled: c.enabled,
      autoStartClaude: c.autoStartClaude,
      autoRemote: c.autoRemote,
      initLine: c.initLine,
      sessionMode: c.sessionMode,
      pinnedSession: c.pinnedSession,
      idlePauseHours: c.idlePauseHours,
      paused: pausedFlag(sess),
      remoteCmd: remoteCmdFor(name),
      remoteUrl: up ? events.remoteUrlOf(sess) : '',
    };
  }));
  return {
    projectsDir: cfg.PROJECTS_DIR,
    panelVersion: cfg.PANEL_VERSION,
    buildTime: cfg.BUILD_TIME,
    login: loginInfo(),
    version: await claudeVersion(),
    remoteNameForced: cfg.REMOTE_CONTROL_NAME,
    shellSession: cfg.SHELL_SESSION,
    settings: conf.settings || {},
    projects,
  };
}

module.exports = {
  listProjects, projConfig, loadConfig, saveConfig, sessionUp, ensureSession, killSession, recreateSession,
  createProject, restartProject, renameProject, deleteProject, sendRemote, setConfig, setPower, setInitLine,
  setSessionMode, pauseProject, unpauseProject,
  buildState,
};
