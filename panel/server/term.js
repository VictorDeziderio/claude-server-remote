'use strict';
const { tr } = require('./i18n');
/*
 * Terminal do painel.
 *
 * 1) TERMINAL REAL (WebSocket /ws/term): abre um PTY (node-pty) rodando `tmux attach` na
 *    sessao pedida e faz a ponte bidirecional com o xterm.js do navegador. E um terminal
 *    de verdade — cores, cursor, TUI do Claude, resize, mouse, tudo passa. Fechar a aba
 *    so desconecta o cliente; a sessao tmux (e o Claude dentro dela) continua viva.
 *
 *    Alvos:  "shell" -> sessao cr-shell (bash em /root, criada sob demanda)
 *            <projeto> -> sessao claude-<projeto> (recriada via claude-session.sh se caiu)
 *    Param `detach=1` -> `attach -d` (derruba outros clientes: "assumir a sessao").
 *
 *    Protocolo (frames de texto): cliente -> servidor: "\x01" + JSON de um tipo conhecido =
 *    controle ({type:'resize',cols,rows} | {type:'ping'}); qualquer outra coisa = teclado (raw).
 *    ("\x01" sozinho e o Ctrl+A do teclado — antes era engolido como controle invalido.)
 *    servidor -> cliente: saida bruta do PTY; "\x01" + JSON = eventos ({type:'ready'|'exit'}).
 *
 * 2) API REST de apoio: capture/send (login do Claude), janelas do tmux (listar/selecionar/
 *    criar/fechar) e exit (Ctrl-C x2).
 */
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const { sh, validName, sessionName, paneOf, clampInt, log } = require('./util');
const fs = require('fs');
const path = require('path');
const { ensureSession, projConfig } = require('./projects');

let pty = null;
try { pty = require('node-pty'); }
catch (e) { log('error', 'node-pty indisponivel — terminal WebSocket desativado (rode npm ci em panel/)', { err: e.message }); }

const hasSession = async (sess) => (await sh('tmux', ['has-session', '-t', '=' + sess])).ok;

async function ensureShell() {
  if (!(await hasSession(cfg.SHELL_SESSION))) {
    await sh('tmux', ['new-session', '-d', '-s', cfg.SHELL_SESSION, '-c', cfg.HOME]); // bash em /root
  }
  return cfg.SHELL_SESSION;
}
// resolve o alvo ("shell" | projeto) p/ nome de sessao tmux, subindo a sessao se preciso
// (projeto DESLIGADO nao sobe: o claude-session.sh respeita enabled=false)
async function targetSession(name, { create = true } = {}) {
  if (!name || name === 'shell') return create ? ensureShell() : cfg.SHELL_SESSION;
  if (!validName(name)) return null;
  const sess = sessionName(name);
  // projeto apagado: a aba de terminal que ficou aberta NAO pode ressuscita-lo
  if (create && !(await hasSession(sess))) {
    if (!fs.existsSync(path.join(cfg.PROJECTS_DIR, name))) return null;
    await ensureSession(name);
  }
  return sess;
}
const isDisabled = (name) => !!name && name !== 'shell' && validName(name) && !projConfig(name).enabled;

// ---------- REST de apoio ----------
// lines = quantas linhas do HISTORICO (alem da tela) trazer: 200 por padrao (login do Claude);
// a tela "Selecionar texto" do celular pede mais (ate CAPTURE_MAX) p/ copiar com o dedo.
const CAPTURE_MAX = 5000;
async function termCapture(name, lines) {
  const sess = await targetSession(name, { create: false });
  if (!sess) return { ok: false, msg: tr('srv.badTarget') };
  if (!(await hasSession(sess))) return { ok: false, msg: tr('srv.sessionDown') };
  const n = clampInt(lines, 0, CAPTURE_MAX, 200);
  // -J junta as linhas quebradas pela largura do terminal (URL longa sai inteira)
  const r = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-J', '-S', '-' + n]);
  // sem as linhas vazias do fim da tela (o tmux preenche ate a ultima linha do painel)
  const content = (r.stdout || '').replace(/\s+$/, '') + (r.stdout ? '\n' : '');
  return { ok: r.ok, content, lines: n, msg: r.ok ? '' : tr('srv.captureFailed') };
}
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'Space', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End', 'IC', 'DC']);
async function termSend(name, text, key) {
  const sess = await targetSession(name);
  if (!sess) return { ok: false, msg: tr('srv.badTarget') };
  if (!(await hasSession(sess))) return { ok: false, msg: tr('srv.sessionDown') };
  if (typeof text === 'string' && text.length) {
    if (text.length > 4096) return { ok: false, msg: 'texto muito longo' };
    await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', text]);
  }
  if (typeof key === 'string' && key.length) {
    if (!KEYS.has(key) && !/^C-[a-z]$/.test(key)) return { ok: false, msg: tr('srv.keyNotAllowed') };
    await sh('tmux', ['send-keys', '-t', paneOf(sess), key]);
  }
  return { ok: true };
}
// Sai do Claude da sessao (Ctrl-C duas vezes). Com autoStart ON o supervisor reabre em ~3s.
async function termExit(name) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badProject') };
  const sess = sessionName(name);
  if (!(await hasSession(sess))) return { ok: false, msg: tr('srv.sessionDown') };
  await sh('tmux', ['send-keys', '-t', paneOf(sess), 'C-c']);
  await new Promise((r) => setTimeout(r, 400));
  await sh('tmux', ['send-keys', '-t', paneOf(sess), 'C-c']);
  return { ok: true, msg: tr('srv.claudeKilled', { sess }) };
}
// janelas do tmux da sessao
async function listWindows(name) {
  const sess = await targetSession(name, { create: false });
  if (!sess) return { ok: false, msg: tr('srv.badTarget') };
  if (!(await hasSession(sess))) return { ok: true, session: sess, windows: [], clients: 0 };
  const [w, c] = await Promise.all([
    sh('tmux', ['list-windows', '-t', '=' + sess, '-F', '#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}']),
    sh('tmux', ['list-clients', '-t', '=' + sess, '-F', '#{client_tty}']),
  ]);
  const windows = (w.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
    const [index, wname, active, cmd] = l.split('\t');
    return { index: parseInt(index, 10), name: wname, active: active === '1', cmd };
  });
  return { ok: true, session: sess, windows, clients: (c.stdout || '').trim().split('\n').filter(Boolean).length };
}
async function windowAction(name, action, index) {
  const sess = await targetSession(name, { create: false });
  if (!sess) return { ok: false, msg: tr('srv.badTarget') };
  if (!(await hasSession(sess))) return { ok: false, msg: tr('srv.sessionDown') };
  const idx = clampInt(index, 0, 99, -1);
  if (action === 'new') { const r = await sh('tmux', ['new-window', '-t', '=' + sess, '-c', cfg.HOME]); return { ok: r.ok, msg: r.ok ? 'nova janela aberta (Ctrl+b n/p alterna)' : r.stderr }; }
  if (idx < 0) return { ok: false, msg: tr('srv.badIndex') };
  if (action === 'select') { const r = await sh('tmux', ['select-window', '-t', `=${sess}:${idx}`]); return { ok: r.ok, msg: r.ok ? '' : r.stderr }; }
  if (action === 'kill') {
    const r = await sh('tmux', ['kill-window', '-t', `=${sess}:${idx}`]);
    return { ok: r.ok, msg: r.ok ? `janela ${idx} fechada` : r.stderr };
  }
  return { ok: false, msg: tr('srv.badAction') };
}

// ---------- WebSocket + PTY ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const live = new Set(); // ptys abertos (p/ encerrar no shutdown)
// achado @security: sem limite, uma sessao de painel (sid) podia abrir WebSockets sem parar,
// cada um subindo um PTY (tmux attach) — cap por sessao de login, nao por IP/global, pra nao
// punir varios dispositivos legitimos atras do mesmo IP.
const MAX_PTY_PER_SID = 10;
const sidCounts = new Map(); // sid -> PTYs abertos agora
const CTRL = '\x01';
const CTL_TYPES = new Set(['resize', 'ping']);
// frame de controle = "\x01" + JSON de um tipo conhecido; senao e teclado (ex.: Ctrl+A = "\x01")
function parseCtl(s) {
  if (s.charCodeAt(0) !== 1 || s.charCodeAt(1) !== 123 /* { */) return null;
  try { const c = JSON.parse(s.slice(1)); return c && CTL_TYPES.has(c.type) ? c : null; } catch { return null; }
}

function attach(ws, params, ip, sid) {
  const name = params.get('name') || 'shell';
  const cols = clampInt(params.get('cols'), 20, 500, 120);
  const rows = clampInt(params.get('rows'), 5, 200, 32);
  const detach = params.get('detach') === '1';
  let proc = null;
  let alive = true;

  const sendCtl = (obj) => { if (ws.readyState === ws.OPEN) ws.send(CTRL + JSON.stringify(obj)); };
  const closeWith = (code, reason) => { try { ws.close(code, reason); } catch { /* */ } };

  if (sid) {
    const n = sidCounts.get(sid) || 0;
    if (n >= MAX_PTY_PER_SID) return closeWith(4009, tr('srv.tooManyTerms'));
    sidCounts.set(sid, n + 1);
  }

  (async () => {
    if (!pty) return closeWith(4003, tr('srv.noPty'));
    const sess = await targetSession(name);
    if (!sess) return closeWith(4000, tr('srv.badTarget'));
    if (!(await hasSession(sess))) {
      return isDisabled(name) ? closeWith(4006, tr('srv.projectOff')) : closeWith(4004, tr('srv.sessionDown'));
    }
    if (!alive) return;
    try {
      // env minimo (sem PANEL_PASSWORD & cia): o cliente tmux so precisa de PATH/HOME/TERM
      const env = { TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: cfg.HOME, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
      for (const k of ['PATH', 'USER', 'LOGNAME', 'TMUX_TMPDIR', 'TZ']) if (process.env[k]) env[k] = process.env[k];
      const args = ['-u', 'attach-session', '-t', '=' + sess];
      if (detach) args.push('-d');
      proc = pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd: cfg.HOME, env });
    } catch (e) {
      log('error', 'falha abrindo PTY', { err: e.message });
      return closeWith(4005, tr('srv.termFail'));
    }
    live.add(proc);
    log('info', 'terminal aberto', { ip, sess, cols, rows, detach });
    sendCtl({ type: 'ready', session: sess });
    // Coalesce: a TUI do Claude emite dezenas de fragmentos por redesenho; agrupamos em janelas
    // de ~8ms (ou 32KB) -> muito menos frames no WebSocket, sem latencia perceptivel.
    let buf = '', flushTimer = null;
    const flush = () => { flushTimer = null; if (buf && ws.readyState === ws.OPEN) ws.send(buf); buf = ''; };
    proc.onData((d) => {
      buf += d;
      if (buf.length >= 32 * 1024) { if (flushTimer) clearTimeout(flushTimer); flush(); return; }
      if (!flushTimer) flushTimer = setTimeout(flush, 8);
    });
    proc.onExit(({ exitCode }) => {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      live.delete(proc); proc = null;
      sendCtl({ type: 'exit', code: exitCode });
      closeWith(1000, tr('srv.sessionEnded'));
    });
  })();

  ws.on('message', (m, isBinary) => {
    const s = isBinary ? m.toString('utf8') : String(m);
    const c = parseCtl(s);
    if (c) {
      if (c.type === 'resize' && proc) {
        const w = clampInt(c.cols, 20, 500, cols), h = clampInt(c.rows, 5, 200, rows);
        try { proc.resize(w, h); } catch { /* pty ja fechou */ }
      } else if (c.type === 'ping') sendCtl({ type: 'pong' });
      return;
    }
    if (proc) proc.write(s);
  });
  let byeDone = false;
  const bye = () => {
    if (byeDone) return;
    byeDone = true;
    alive = false;
    if (sid) { const n = (sidCounts.get(sid) || 1) - 1; if (n <= 0) sidCounts.delete(sid); else sidCounts.set(sid, n); }
    if (proc) { try { proc.kill(); } catch { /* */ } live.delete(proc); proc = null; }
  };
  ws.on('close', bye);
  ws.on('error', bye);

  // keepalive (proxies derrubam WS ocioso)
  const hb = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); else clearInterval(hb); }, 25000);
  ws.on('close', () => clearInterval(hb));
}

function handleUpgrade(req, socket, head, params, ip, sid) {
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, params, ip, sid));
}
function shutdown() {
  for (const p of live) { try { p.kill(); } catch { /* */ } }
  live.clear();
  for (const c of wss.clients) { try { c.terminate(); } catch { /* */ } }
}

module.exports = { CAPTURE_MAX, termCapture, termSend, termExit, listWindows, windowAction, handleUpgrade, shutdown, ptyAvailable: !!pty };
