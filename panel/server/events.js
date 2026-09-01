'use strict';
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
const crypto = require('crypto');
const cfg = require('./config');
const { sh, sessionName, log } = require('./util');
const { listProjects } = require('./projects-list');

const clients = new Set();           // res de cada EventSource conectado
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
function broadcast(event, data) { for (const res of clients) send(res, event, data); }

function attach(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  clients.add(res);
  if (lastState) send(res, 'state', lastState);
  send(res, 'activity', activitySnapshot());
  const hb = setInterval(() => send(res, 'ping', { t: Date.now() }), 20000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
}

const activitySnapshot = () => {
  const out = {};
  for (const [sess, a] of act) out[sess] = { state: a.state, since: a.changedAt, busySince: a.busySince || 0, remoteUrl: a.remoteUrl || '' };
  return out;
};
const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function tickSession(name, running) {
  const sess = sessionName(name);
  const a = act.get(sess) || { hash: '', changedAt: Date.now(), busySince: 0, state: 'off', remoteUrl: '', quietTicks: 0 };
  act.set(sess, a);
  const prevState = a.state;
  if (!running) {
    a.state = 'off'; a.busySince = 0;
    if (prevState !== 'off') { a.changedAt = Date.now(); broadcast('activity', { name, session: sess, state: 'off', since: a.changedAt }); }
    return;
  }
  const r = await sh('tmux', ['capture-pane', '-t', '=' + sess, '-p', '-S', '-300']);
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
    a.state = next; a.changedAt = now;
    broadcast('activity', { name, session: sess, state: next, since: now });
    if (next === 'prompt') {
      broadcast('notify', { kind: 'prompt', name, title: `Claude está esperando você — ${name}`, body: 'Há uma pergunta/permissão pendente no terminal.' });
    } else if (next === 'idle' && prevState === 'busy' && busyFor >= 5000) {
      broadcast('notify', { kind: 'done', name, title: `Claude terminou — ${name}`, body: `Ficou ${Math.round(busyFor / 1000)}s trabalhando e agora está aguardando.` });
    }
    if (next !== 'busy') a.busySince = 0;
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const state = stateBuilder ? await stateBuilder() : null;
    if (state) {
      await Promise.all(state.projects.map((p) => tickSession(p.name, p.up && p.claudeRunning)));
      // enriquece com atividade/remoteUrl do watcher
      for (const p of state.projects) {
        const a = act.get(p.session);
        p.activity = a ? a.state : 'off';
        p.activitySince = a ? a.changedAt : 0;
        if (a && a.remoteUrl && p.up) p.remoteUrl = a.remoteUrl;
      }
      // limpa sessoes de projetos que sumiram
      const names = new Set(state.projects.map((p) => p.session));
      for (const k of act.keys()) if (!names.has(k)) act.delete(k);
      lastState = state;
      const h = hashOf(JSON.stringify(state));
      if (h !== lastStateHash) { lastStateHash = h; broadcast('state', state); }
    }
  } catch (e) { log('error', 'watcher', { err: e.message }); }
  finally { ticking = false; }
}

function start(builder) {
  stateBuilder = builder;
  if (timer) return;
  tick();
  timer = setInterval(tick, cfg.WATCH_INTERVAL_MS);
  timer.unref();
}
// forca um tick agora (depois de uma acao) p/ o SSE refletir na hora
const poke = () => { setTimeout(tick, 150); };
const remoteUrlOf = (sess) => (act.get(sess) || {}).remoteUrl || '';
const currentState = async () => lastState || (stateBuilder ? stateBuilder() : null);
function stop() { if (timer) clearInterval(timer); for (const res of clients) { try { res.end(); } catch { /* */ } } clients.clear(); }

module.exports = { attach, broadcast, start, stop, poke, remoteUrlOf, currentState, activitySnapshot, clientCount: () => clients.size };
