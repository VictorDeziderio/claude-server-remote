'use strict';
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
 *    Protocolo (frames de texto): cliente -> servidor: "\x01" + JSON = controle
 *    ({type:'resize',cols,rows} | {type:'ping'}); qualquer outra coisa = teclado (raw).
 *    servidor -> cliente: saida bruta do PTY; "\x01" + JSON = eventos ({type:'ready'|'exit'}).
 *
 * 2) API REST de apoio: capture/send (login do Claude), janelas do tmux (listar/selecionar/
 *    criar/fechar) e exit (Ctrl-C x2).
 */
const { WebSocketServer } = require('ws');
const cfg = require('./config');
const { sh, validName, sessionName, clampInt, log } = require('./util');
const { ensureSession } = require('./projects');

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
async function targetSession(name, { create = true } = {}) {
  if (!name || name === 'shell') return create ? ensureShell() : cfg.SHELL_SESSION;
  if (!validName(name)) return null;
  const sess = sessionName(name);
  if (create && !(await hasSession(sess))) await ensureSession(name);
  return sess;
}

// ---------- REST de apoio ----------
async function termCapture(name) {
  const sess = await targetSession(name, { create: false });
  if (!sess) return { ok: false, msg: 'alvo invalido' };
  if (!(await hasSession(sess))) return { ok: false, msg: 'sessao nao esta de pe' };
  const r = await sh('tmux', ['capture-pane', '-t', sess, '-p', '-S', '-200']);
  return { ok: r.ok, content: r.stdout || '', msg: r.ok ? '' : 'falha ao capturar a tela' };
}
const KEYS = new Set(['Enter', 'Escape', 'Tab', 'Space', 'BSpace', 'Up', 'Down', 'Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End', 'IC', 'DC']);
async function termSend(name, text, key) {
  const sess = await targetSession(name);
  if (!sess) return { ok: false, msg: 'alvo invalido' };
  if (!(await hasSession(sess))) return { ok: false, msg: 'sessao nao esta de pe' };
  if (typeof text === 'string' && text.length) {
    if (text.length > 4096) return { ok: false, msg: 'texto muito longo' };
    await sh('tmux', ['send-keys', '-t', sess, '-l', text]);
  }
  if (typeof key === 'string' && key.length) {
    if (!KEYS.has(key) && !/^C-[a-z]$/.test(key)) return { ok: false, msg: 'tecla nao permitida' };
    await sh('tmux', ['send-keys', '-t', sess, key]);
  }
  return { ok: true };
}
// Sai do Claude da sessao (Ctrl-C duas vezes). Com autoStart ON o supervisor reabre em ~3s.
async function termExit(name) {
  if (!validName(name)) return { ok: false, msg: 'projeto invalido' };
  const sess = sessionName(name);
  if (!(await hasSession(sess))) return { ok: false, msg: 'sessao nao esta de pe' };
  await sh('tmux', ['send-keys', '-t', sess, 'C-c']);
  await new Promise((r) => setTimeout(r, 400));
  await sh('tmux', ['send-keys', '-t', sess, 'C-c']);
  return { ok: true, msg: `Claude encerrado em ${sess} — o supervisor abre uma nova conversa` };
}
// janelas do tmux da sessao
async function listWindows(name) {
  const sess = await targetSession(name, { create: false });
  if (!sess) return { ok: false, msg: 'alvo invalido' };
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
  if (!sess) return { ok: false, msg: 'alvo invalido' };
  if (!(await hasSession(sess))) return { ok: false, msg: 'sessao nao esta de pe' };
  const idx = clampInt(index, 0, 99, -1);
  if (action === 'new') { const r = await sh('tmux', ['new-window', '-t', '=' + sess, '-c', cfg.HOME]); return { ok: r.ok, msg: r.ok ? 'nova janela aberta (Ctrl+b n/p alterna)' : r.stderr }; }
  if (idx < 0) return { ok: false, msg: 'indice invalido' };
  if (action === 'select') { const r = await sh('tmux', ['select-window', '-t', `=${sess}:${idx}`]); return { ok: r.ok, msg: r.ok ? '' : r.stderr }; }
  if (action === 'kill') {
    const r = await sh('tmux', ['kill-window', '-t', `=${sess}:${idx}`]);
    return { ok: r.ok, msg: r.ok ? `janela ${idx} fechada` : r.stderr };
  }
  return { ok: false, msg: 'acao invalida' };
}

// ---------- WebSocket + PTY ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
const live = new Set(); // ptys abertos (p/ encerrar no shutdown)
const CTRL = '\x01';

function attach(ws, params, ip) {
  const name = params.get('name') || 'shell';
  const cols = clampInt(params.get('cols'), 20, 500, 120);
  const rows = clampInt(params.get('rows'), 5, 200, 32);
  const detach = params.get('detach') === '1';
  let proc = null;
  let alive = true;

  const sendCtl = (obj) => { if (ws.readyState === ws.OPEN) ws.send(CTRL + JSON.stringify(obj)); };
  const closeWith = (code, reason) => { try { ws.close(code, reason); } catch { /* */ } };

  (async () => {
    if (!pty) return closeWith(4003, 'node-pty indisponivel no servidor');
    const sess = await targetSession(name);
    if (!sess) return closeWith(4000, 'alvo invalido');
    if (!(await hasSession(sess))) return closeWith(4004, 'sessao nao esta de pe');
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
      return closeWith(4005, 'falha ao abrir o terminal');
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
      closeWith(1000, 'sessao encerrada');
    });
  })();

  ws.on('message', (m, isBinary) => {
    const s = isBinary ? m.toString('utf8') : String(m);
    if (s.charCodeAt(0) === 1) {
      let c; try { c = JSON.parse(s.slice(1)); } catch { return; }
      if (c.type === 'resize' && proc) {
        const w = clampInt(c.cols, 20, 500, cols), h = clampInt(c.rows, 5, 200, rows);
        try { proc.resize(w, h); } catch { /* pty ja fechou */ }
      } else if (c.type === 'ping') sendCtl({ type: 'pong' });
      return;
    }
    if (proc) proc.write(s);
  });
  const bye = () => {
    alive = false;
    if (proc) { try { proc.kill(); } catch { /* */ } live.delete(proc); proc = null; }
  };
  ws.on('close', bye);
  ws.on('error', bye);

  // keepalive (proxies derrubam WS ocioso)
  const hb = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); else clearInterval(hb); }, 25000);
  ws.on('close', () => clearInterval(hb));
}

function handleUpgrade(req, socket, head, params, ip) {
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, params, ip));
}
function shutdown() {
  for (const p of live) { try { p.kill(); } catch { /* */ } }
  live.clear();
  for (const c of wss.clients) { try { c.terminate(); } catch { /* */ } }
}

module.exports = { termCapture, termSend, termExit, listWindows, windowAction, handleUpgrade, shutdown, ptyAvailable: !!pty };
