'use strict';
const { tr } = require('./i18n');
/*
 * Tempo real: watcher + SSE (/api/events).
 *
 * A cada WATCH_INTERVAL_MS o watcher olha cada sessao de projeto (tmux capture-pane das
 * ultimas 300 linhas) e mantem:
 *   - activity: 'busy' (tela mudando) | 'idle' (parada) | 'prompt' (Claude esperando uma
 *     resposta sua: permissao/confirmacao) | 'off' (sessao/Claude parados)
 *   - remoteUrl (link claude.ai/code/... mais recente na tela)
 * Transicoes busy->idle (apos >=5s ocupado) e ->prompt geram NOTIFICACOES.
 * O estado consolidado (buildState) e recalculado a cada tick e enviado por SSE so quando
 * muda (hash), entao o cliente nao precisa de polling.
 *
 * Eventos SSE: state {…}, activity {name,state,since}, notify {title,body,name,kind}, ping.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { sh, sessionName, paneOf, log } = require('./util');
const { listProjects } = require('./projects-list');

const clients = new Set();           // res de cada EventSource conectado
// achado @security: sem limite, uma sessao de painel (sid) reconectando em loop (bug no cliente
// ou de proposito) acumulava EventSource abertos pra sempre — cada um com seu heartbeat/broadcast.
const MAX_SSE_PER_SID = 5;
const sidCounts = new Map();         // sid -> EventSource abertos agora
const act = new Map();               // sess -> { hash, changedAt, busySince, state, remoteUrl, lastLines }
let lastStateHash = '';
let lastState = null;
let stateBuilder = null;             // injetado por projects.js (evita ciclo)
let timer = null;
let ticking = false;

// padroes na tela que indicam "Claude esperando VOCE" (permissao/confirmacao/escolha)
// (o dialogo do /remote-control — "Esc to continue" — NAO conta: o loop/painel fecham sozinhos)
const PROMPT_RX = /(Do you want to (proceed|allow|make this edit|run|create|continue)|Allow (this|the) |Yes, (and )?(don't|allow|proceed)|^\s*(❯\s*)?1\.\s*Yes\b|\(y\/n\)|\[Y\/n\]|Would you like to|permission to|Waiting for (your )?(input|approval))/im;
const REMOTE_RX = /https:\/\/claude\.ai\/code\/[^\s'"()\]]+/g;

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* cliente sumiu */ }
}
// 'notify' also goes to in-process listeners (notify.js -> Web Push), with or without SSE clients
const notifyListeners = [];
const onNotify = (cb) => { if (typeof cb === 'function') notifyListeners.push(cb); };
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
  if (event === 'notify') for (const cb of notifyListeners) { try { cb(data); } catch (e) { log('error', 'notify listener', { err: e.message }); } }
}

function attach(req, res, sid) {
  if (sid) {
    const n = sidCounts.get(sid) || 0;
    if (n >= MAX_SSE_PER_SID) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(tr('srv.tooManyEvents'));
    }
    sidCounts.set(sid, n + 1);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  clients.add(res);
  if (lastState) send(res, 'state', lastState);
  send(res, 'activity', activitySnapshot());
  poke(); // o watcher pausa sem clientes: atualiza estado/atividade ja na reconexao
  const hb = setInterval(() => send(res, 'ping', { t: Date.now() }), 20000);
  req.on('close', () => {
    clearInterval(hb); clients.delete(res);
    if (sid) { const n = (sidCounts.get(sid) || 1) - 1; if (n <= 0) sidCounts.delete(sid); else sidCounts.set(sid, n); }
  });
}

const activitySnapshot = () => {
  const out = {};
  for (const [sess, a] of act) out[sess] = { state: a.state, since: a.changedAt, busySince: a.busySince || 0, remoteUrl: a.remoteUrl || '' };
  return out;
};
const activityOf = (sess) => (act.get(sess) || {}).state || 'off';
const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex');

// pausa por inatividade: grava o flag que o claude-loop.sh respeita e manda /exit (Ctrl-C ja
// NAO e usado aqui — /exit fecha a conversa de forma limpa). Chamado quando idle/prompt dura
// >= idlePauseHours (config por projeto) — ver o fim de tickSession.
async function autoPauseSession(name, sess) {
  try {
    fs.mkdirSync(cfg.RUN_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.RUN_DIR, sess + '.paused'), 'idle');
    await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', '/exit']);
    await sh('tmux', ['send-keys', '-t', paneOf(sess), 'Enter']);
    log('info', 'projeto pausado por inatividade', { name, sess });
    poke();
  } catch (e) { log('error', 'auto-pause', { err: e.message }); }
}

async function tickSession(name, running, idlePauseHours) {
  const sess = sessionName(name);
  const a = act.get(sess) || { hash: '', changedAt: Date.now(), busySince: 0, state: 'off', remoteUrl: '', quietTicks: 0, autoPaused: false };
  act.set(sess, a);
  const prevState = a.state;
  if (!running) {
    a.state = 'off'; a.busySince = 0; a.autoPaused = false;
    if (prevState !== 'off') { a.changedAt = Date.now(); broadcast('activity', { name, session: sess, state: 'off', since: a.changedAt, busySince: 0, remoteUrl: a.remoteUrl || '' }); }
    return;
  }
  // -J: junta as linhas quebradas pela largura (o link do remote sai inteiro)
  const r = await sh('tmux', ['capture-pane', '-t', '=' + sess + ':', '-p', '-J', '-S', '-300']);
  if (!r.ok) return;
  const screen = r.stdout || '';
  const m = screen.match(REMOTE_RX);
  if (m) a.remoteUrl = m[m.length - 1];
  const tail = screen.split('\n').slice(-60).join('\n');
  const h = hashOf(tail);
  const now = Date.now();
  let next;
  if (h !== a.hash) {
    a.hash = h; a.quietTicks = 0;
    if (!a.busySince) a.busySince = now;
    next = 'busy';
  } else {
    a.quietTicks++;
    // parado ha >= 2 ticks (~4s): idle ou prompt (se a tela pede algo); antes disso mantem o estado
    if (a.quietTicks >= 2) next = PROMPT_RX.test(tail) ? 'prompt' : 'idle';
    else next = a.state === 'off' ? 'idle' : a.state;
  }
  if (next !== prevState) {
    const busyFor = a.busySince ? now - a.busySince : 0;
    a.state = next; a.changedAt = now; a.autoPaused = false; // qualquer transicao reinicia o relogio de inatividade
    // manda busySince/remoteUrl junto (achado @qa 2026-09-28): o reducer do cliente
    // (useEvents.js) faz merge, mas o payload precisa trazer o valor certo — 0 quando
    // sai de 'busy' (o reset de a.busySince abaixo so acontece DEPOIS deste broadcast)
    broadcast('activity', { name, session: sess, state: next, since: now, busySince: next === 'busy' ? a.busySince : 0, remoteUrl: a.remoteUrl || '' });
    if (next === 'prompt') {
      broadcast('notify', { kind: 'prompt', name, title: tr('srv.waitingTitle', { name }), body: tr('srv.waitingBody'), i18n: { title: ['srv.waitingTitle', { name }], body: ['srv.waitingBody'] } });
    } else if (next === 'idle' && prevState === 'busy' && busyFor >= 5000) {
      const secs = Math.round(busyFor / 1000);
      broadcast('notify', { kind: 'done', name, title: tr('srv.doneTitle', { name }), body: tr('srv.doneBody', { s: secs }), i18n: { title: ['srv.doneTitle', { name }], body: ['srv.doneBody', { s: secs }] } });
    }
    if (next !== 'busy') a.busySince = 0;
  }
  // pausa automatica: idle/prompt (nao-busy) ha >= idlePauseHours SEM interrupcao — so dispara 1x
  // por periodo ocioso (a.autoPaused), que e' reiniciado por qualquer transicao de estado acima
  if (idlePauseHours > 0 && !a.autoPaused && (a.state === 'idle' || a.state === 'prompt') && (now - a.changedAt) >= idlePauseHours * 3600 * 1000) {
    a.autoPaused = true;
    autoPauseSession(name, sess);
  }
}

// estado completo: projetos + atividade/remoteUrl do watcher (captura tmux de cada sessao)
async function buildFullState() {
  const state = stateBuilder ? await stateBuilder() : null;
  if (!state) return null;
  await Promise.all(state.projects.map((p) => tickSession(p.name, p.up && p.claudeRunning, p.idlePauseHours)));
  for (const p of state.projects) {
    const a = act.get(p.session);
    p.activity = a ? a.state : 'off';
    p.activitySince = a ? a.changedAt : 0;
    if (a && a.remoteUrl && p.up) p.remoteUrl = a.remoteUrl;
  }
  // limpa sessoes de projetos que sumiram
  const names = new Set(state.projects.map((p) => p.session));
  for (const k of act.keys()) if (!names.has(k)) act.delete(k);
  return state;
}

async function tick() {
  if (ticking) return;
  // achado @perf 2026-10-09: painel fechado (nenhum EventSource conectado) nao precisa
  // capturar tmux a cada tick — ninguem vai ver o broadcast. Mas o lastState congelado
  // ficaria velho (GET /api/state e o 1o evento do SSE o servem): descarta, currentState()
  // monta um completo sob demanda e attach() forca um tick ao reconectar.
  if (clients.size === 0) { lastState = null; lastStateHash = ''; return; }
  ticking = true;
  try {
    const state = await buildFullState();
    if (state) {
      lastState = state;
      const h = hashOf(JSON.stringify(state));
      if (h !== lastStateHash) { lastStateHash = h; broadcast('state', state); }
    }
  } catch (e) { log('error', 'watcher', { err: e.message }); }
  finally { ticking = false; }
}

// achado @perf: com RUN_DIR/lowmem presente (guarda de memoria do lado shell), o watcher cai
// de WATCH_INTERVAL_MS (2s) p/ 10s — menos capture-pane/CPU enquanto a memoria esta apertada.
const lowMemFlag = () => { try { return fs.existsSync(path.join(cfg.RUN_DIR, 'lowmem')); } catch { return false; } };
function scheduleTick() {
  const ms = lowMemFlag() ? 10000 : cfg.WATCH_INTERVAL_MS;
  timer = setTimeout(() => { tick().finally(scheduleTick); }, ms);
  timer.unref();
}
function start(builder) {
  stateBuilder = builder;
  if (timer) return;
  tick().finally(scheduleTick);
}
// forca um tick agora (depois de uma acao) p/ o SSE refletir na hora
const poke = () => { setTimeout(tick, 150); };
const remoteUrlOf = (sess) => (act.get(sess) || {}).remoteUrl || '';
const currentState = async () => lastState || buildFullState();
function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const res of clients) { try { res.end(); } catch { /* */ } }
  clients.clear();
}

module.exports = { attach, broadcast, onNotify, start, stop, poke, remoteUrlOf, currentState, activitySnapshot, activityOf, PROMPT_RX, clientCount: () => clients.size };
