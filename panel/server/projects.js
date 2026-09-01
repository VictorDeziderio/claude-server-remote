'use strict';
// Projetos: config (panel.json), sessoes tmux por projeto, acoes (criar/renomear/excluir/
// reiniciar/remote/primeira linha) e o estado consolidado do dashboard.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { sh, validName, sessionName, truthy, log } = require('./util');
const { listProjects } = require('./projects-list');
const { loginInfo, claudeVersion } = require('./claude');
const { usageSummary } = require('./usage');
const events = require('./events');

const remoteCmdFor = (name) => '/remote-control ' + (cfg.REMOTE_CONTROL_NAME || name);

// ---------- config (panel.json) ----------
const DEFAULTS = { autoStartClaude: true, autoRemote: true };
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
function projConfig(name) {
  const c = loadConfig();
  const d = c.defaults || {};
  const p = (c.projects && c.projects[name]) || {};
  const pick = (k) => (k in p ? !!p[k] : (k in d ? !!d[k] : true));
  return {
    autoStartClaude: pick('autoStartClaude'),
    autoRemote: pick('autoRemote'),
    initLine: typeof p.initLine === 'string' ? p.initLine : '', // "primeira linha" enviada ao Claude quando ele fica pronto
  };
}
function setProjConfig(name, patch) {
  const c = loadConfig();
  c.projects = c.projects || {};
  c.projects[name] = Object.assign({}, c.projects[name], patch);
  return saveConfig(c);
}

// ---------- sessao tmux ----------
const sessionUp = async (sess) => (await sh('tmux', ['has-session', '-t', '=' + sess])).ok;
const ensureSession = (name) => sh('bash', [cfg.SESSION_SCRIPT, name]);
// Claude de fato rodando nessa sessao? flag file mantido pelo claude-loop.sh
function claudeRunningFlag(sess) {
  try { return fs.existsSync(path.join(cfg.RUN_DIR, sess + '.running')); } catch { return false; }
}

// ---------- acoes ----------
async function createProject(name, autoStartClaude, autoRemote) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido (use letras, numeros, . _ -)' };
  const dir = path.join(cfg.PROJECTS_DIR, name);
  if (fs.existsSync(dir)) return { ok: false, msg: 'ja existe' };
  fs.mkdirSync(dir, { recursive: true });
  await sh('git', ['-C', dir, 'init', '-q']);
  setProjConfig(name, { autoStartClaude: !!autoStartClaude, autoRemote: !!autoRemote });
  await ensureSession(name);
  events.poke();
  return { ok: true, msg: `projeto "${name}" criado e sessao iniciada (Claude ${autoStartClaude ? 'ON' : 'OFF'}, remote ${autoRemote ? 'ON' : 'OFF'})` };
}
async function restartProject(name) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (!fs.existsSync(path.join(cfg.PROJECTS_DIR, name))) return { ok: false, msg: 'pasta inexistente' };
  const sess = sessionName(name);
  // Mata a SESSAO INTEIRA (fecha remote + Claude + tmux) e recria do zero. O claude-session.sh
  // reabre o tmux + o Claude (supervisor), que re-emite o remote-control e envia a primeira linha.
  await sh('tmux', ['kill-session', '-t', '=' + sess]);
  await ensureSession(name);
  events.poke();
  const c = projConfig(name);
  return { ok: true, msg: `"${name}": sessao reiniciada — Claude reaberto${c.autoRemote ? ', remote religado' : ''}${c.initLine ? ' e primeira linha enviada' : ''}` };
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
  await sh('tmux', ['kill-session', '-t', '=' + sessionName(oldName)]);
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
  await sh('tmux', ['kill-session', '-t', '=' + sessionName(name)]);
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { return { ok: false, msg: 'falha ao excluir: ' + e.message }; }
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
  const cmd = remoteCmdFor(name);
  // Mesmo metodo do claude-loop.sh: texto literal, pausa p/ a TUI processar, depois Enter (C-m).
  await sh('tmux', ['send-keys', '-t', sess, '-l', cmd]);
  await new Promise((r) => setTimeout(r, 800));
  await sh('tmux', ['send-keys', '-t', sess, 'C-m']);
  // o /remote-control abre um dialogo ("> Continue · Esc to continue") que trava o prompt:
  // em ~10s, se ele estiver na tela, manda Esc p/ voltar ao prompt (o link continua valido)
  setTimeout(async () => {
    for (let i = 0; i < 5; i++) {
      const r = await sh('tmux', ['capture-pane', '-t', sess, '-p', '-S', '-60']);
      if (!r.ok || !/Esc to continue|Disconnect this session|Show QR code/.test(r.stdout)) break;
      await sh('tmux', ['send-keys', '-t', sess, 'Escape']);
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    events.poke();
  }, 10000);
  events.poke();
  return { ok: true, msg: `remote reenviado: ${cmd} — o link aparece no card em alguns segundos` };
}
async function setConfig(name, key, value) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  if (key !== 'autoStartClaude' && key !== 'autoRemote') return { ok: false, msg: 'chave invalida' };
  const val = truthy(value);
  if (!setProjConfig(name, { [key]: val })) return { ok: false, msg: 'falha ao salvar panel.json' };
  events.poke();
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
  return { ok: true, msg: `"${name}": auto-start do Claude = ${val ? 'ON' : 'OFF'} — reinicie a sessao p/ aplicar` };
}
async function setInitLine(name, text) {
  if (!validName(name)) return { ok: false, msg: 'nome invalido' };
  const t = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').slice(0, 1000);
  if (!setProjConfig(name, { initLine: t })) return { ok: false, msg: 'falha ao salvar panel.json' };
  events.poke();
  return { ok: true, msg: t ? `"${name}": primeira linha salva (vale no proximo inicio do Claude)` : `"${name}": primeira linha removida` };
}

// ---------- estado consolidado (dashboard) ----------
async function buildState() {
  const names = listProjects();
  const projects = await Promise.all(names.map(async (name) => {
    const sess = sessionName(name);
    const up = await sessionUp(sess);
    const c = projConfig(name);
    return {
      name,
      dir: path.join(cfg.PROJECTS_DIR, name),
      session: sess,
      up,
      claudeRunning: up && claudeRunningFlag(sess),
      autoStartClaude: c.autoStartClaude,
      autoRemote: c.autoRemote,
      initLine: c.initLine,
      remoteCmd: remoteCmdFor(name),
      remoteUrl: up ? events.remoteUrlOf(sess) : '',
    };
  }));
  const conf = loadConfig();
  return {
    projectsDir: cfg.PROJECTS_DIR,
    login: loginInfo(),
    version: await claudeVersion(),
    remoteNameForced: cfg.REMOTE_CONTROL_NAME,
    shellSession: cfg.SHELL_SESSION,
    settings: conf.settings || {},
    usage: usageSummary(),
    projects,
  };
}

module.exports = {
  listProjects, projConfig, loadConfig, saveConfig, sessionUp, ensureSession,
  createProject, restartProject, renameProject, deleteProject, sendRemote, setConfig, setInitLine,
  buildState,
};
