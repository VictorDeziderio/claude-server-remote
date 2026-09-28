'use strict';
/*
 * Login do Claude Code GUIADO pelo painel (Conta -> Logar no Claude).
 *
 * Roda o `claude` numa sessao tmux dedicada (cr-login) LARGA (500 colunas, ninguem anexa) —
 * assim o link OAuth nunca quebra em varias linhas e sai inteiro para copiar. Um "piloto"
 * le a tela a cada segundo e avanca sozinho as telas conhecidas:
 *   tema ("Choose the text style")            -> Enter (mantem o default)
 *   "Select login method"                      -> garante "1. Claude account with subscription" + Enter
 *   "Press Enter to continue" / notas          -> Enter
 *   ja logado (REPL pronto)                    -> envia /login (troca de conta)
 *   link OAuth na tela                         -> fase "url": o painel mostra o link + campo do codigo
 *   "Login successful"                         -> Enter, encerra a sessao e reinicia os projetos
 *                                                 que estavam parados na tela de login
 * Telas que pedem decisao do dono (ex.: aceitar o modo bypass) NAO sao respondidas: fase
 * "attention" — o painel mostra a tela e as teclas para voce responder.
 */
const cfg = require('./config');
const { sh, paneOf, log } = require('./util');
const { loginInfo } = require('./claude');

const SESS = 'cr-login';
const PANE = paneOf(SESS);
const MAX_MS = 15 * 60 * 1000;

const RX = {
  success: /Login successful|Logged in (successfully|as)|Successfully logged in/i,
  url: /https:\/\/[^\s"'<>]*(?:oauth|authorize)[^\s"'<>]*/i,
  paste: /Paste (the )?code|Paste code here|authorization code/i,
  method: /Select login method/i,
  methodOk: /❯\s*1\.\s*Claude account/,
  theme: /Choose the text style|text style that looks best/i,
  enter: /Press Enter to continue|Security notes/i,
  repl: /\? for shortcuts|bypass permissions on|shift\+tab to cycle/i,
  error: /OAuth error|Login failed|Invalid (code|authorization)|Request failed|timed out/i,
};

let st = idle();
let timer = null;
function idle() { return { phase: 'idle', url: '', msg: '', startedAt: 0, lastActAt: 0, sentLogin: false, codeAt: 0, screen: '' }; }

const hasSess = async () => (await sh('tmux', ['has-session', '-t', '=' + SESS])).ok;
const capture = async () => {
  const r = await sh('tmux', ['capture-pane', '-t', PANE, '-p', '-J', '-S', '-60']);
  return r.ok ? r.stdout.replace(/\s+$/g, '') : '';
};
const keys = (...k) => sh('tmux', ['send-keys', '-t', PANE, ...k]);
const lastLines = (s, n) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

// uma acao por vez, com respiro p/ a TUI redesenhar
function act(fn) {
  if (Date.now() - st.lastActAt < 1200) return;
  st.lastActAt = Date.now();
  fn();
}

async function tick() {
  if (st.phase === 'idle' || st.phase === 'success') return;
  if (Date.now() - st.startedAt > MAX_MS) { await cancel('tempo esgotado (15 min) — comece de novo'); return; }
  if (!(await hasSess())) {
    if (st.phase !== 'error') {
      st.phase = loginInfo().logged ? 'success' : 'error';
      st.msg = st.phase === 'success' ? 'login concluido' : 'o claude fechou antes de concluir o login';
    }
    stopTimer();
    return;
  }
  const screen = await capture();
  st.screen = lastLines(screen, 40);

  if (RX.success.test(screen)) {
    st.phase = 'success'; st.msg = 'login concluido';
    stopTimer();
    await keys('Enter');
    setTimeout(async () => { await sh('tmux', ['kill-session', '-t', '=' + SESS]); await restartStuckProjects(); }, 2500);
    return;
  }
  const url = (screen.match(new RegExp(RX.url.source, 'gi')) || []).pop();
  if (url) {
    st.url = url;
    if (st.codeAt && RX.error.test(lastLines(screen, 8))) { st.phase = 'error'; st.msg = 'o Claude recusou o codigo — gere um novo link e tente de novo'; return; }
    st.phase = st.codeAt ? 'code-sent' : 'url';
    return;
  }
  if (RX.method.test(screen)) {
    st.phase = 'method';
    act(() => (RX.methodOk.test(screen) ? keys('Enter') : keys('Up')));
    return;
  }
  if (RX.theme.test(screen)) { st.phase = 'starting'; act(() => keys('Enter')); return; }
  if (RX.enter.test(screen)) { st.phase = 'starting'; act(() => keys('Enter')); return; }
  if (RX.repl.test(screen)) {
    // ja logado: abre o /login (troca de conta) uma vez
    if (!st.sentLogin) { st.sentLogin = true; st.phase = 'starting'; act(async () => { await keys('-l', '/login'); setTimeout(() => keys('Enter'), 500); }); }
    return;
  }
  // tela desconhecida por mais de 20s -> pede atencao do dono (mostra a tela + teclas)
  if (Date.now() - st.startedAt > 20000) st.phase = 'attention';
}

function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

async function start() {
  stopTimer();
  await sh('tmux', ['kill-session', '-t', '=' + SESS]);
  const r = await sh('tmux', ['new-session', '-d', '-s', SESS, '-x', '500', '-y', '50', '-c', cfg.HOME, 'claude']);
  if (!r.ok) { st = { ...idle(), phase: 'error', msg: 'nao consegui abrir o claude: ' + r.stderr.trim() }; return status(); }
  // largura FIXA: sem cliente anexado a janela nunca encolhe
  await sh('tmux', ['set-option', '-t', '=' + SESS, 'window-size', 'manual']);
  await sh('tmux', ['set-option', '-t', '=' + SESS, 'status', 'off']);
  st = { ...idle(), phase: 'starting', startedAt: Date.now() };
  timer = setInterval(() => { tick().catch((e) => log('error', 'login tick', { err: e.message })); }, 1000);
  timer.unref();
  log('info', 'login do Claude iniciado');
  return status();
}

async function sendCode(code) {
  const c = String(code || '').trim();
  if (!c || c.length > 2000 || /[\x00-\x1f\x7f]/.test(c)) return { ok: false, msg: 'codigo invalido' };
  if (!(await hasSess())) return { ok: false, msg: 'o login nao esta em andamento — clique em Conectar' };
  await keys('-l', c);
  await new Promise((r) => setTimeout(r, 400));
  await keys('Enter');
  st.codeAt = Date.now(); st.phase = 'code-sent'; st.msg = '';
  return { ok: true, msg: 'codigo enviado — validando…' };
}

// teclas manuais p/ telas que pedem decisao (fase "attention")
const KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', '1', '2', '3']);
async function sendKey(key) {
  if (!KEYS.has(key)) return { ok: false, msg: 'tecla nao permitida' };
  if (!(await hasSess())) return { ok: false, msg: 'o login nao esta em andamento' };
  await keys(key);
  st.lastActAt = Date.now();
  return { ok: true };
}

async function cancel(msg) {
  stopTimer();
  await sh('tmux', ['kill-session', '-t', '=' + SESS]);
  st = { ...idle(), msg: msg || '' };
  return { ok: true, msg: msg || 'login cancelado' };
}

function status() {
  return { ok: true, phase: st.phase, url: st.url, msg: st.msg, screen: st.screen, logged: loginInfo().logged };
}

// Projetos cujo Claude subiu ANTES do login ficam parados na tela de login/tema: reinicia so
// esses (os que ja estavam trabalhando nao sao tocados).
async function restartStuckProjects() {
  try {
    const projects = require('./projects'); // lazy: evita ciclo de require
    for (const name of projects.listProjects()) {
      const sess = require('./util').sessionName(name);
      const r = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-J', '-S', '-60']);
      if (r.ok && (RX.method.test(r.stdout) || RX.theme.test(r.stdout) || RX.paste.test(r.stdout))) {
        log('info', 'reiniciando projeto parado na tela de login', { name });
        await projects.recreateSession(name);
      }
    }
    require('./events').poke();
  } catch (e) { log('error', 'restartStuckProjects', { err: e.message }); }
}

module.exports = { start, sendCode, sendKey, cancel, status, SESSION: SESS };
