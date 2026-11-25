'use strict';
const { tr } = require('./i18n');
/*
 * Login do Claude Code GUIADO pelo painel (Conta -> Logar no Claude).
 *
 * Roda o `claude` (TUI) numa sessao tmux dedicada (cr-login) LARGA (500 colunas, ninguem anexa) —
 * assim o link OAuth nunca quebra em varias linhas e sai inteiro para copiar. Um "piloto" le a
 * tela VISIVEL a cada segundo e responde sozinho TODAS as telas conhecidas, antes e depois do
 * login (tabela SCREENS abaixo). O dono so ve: progresso -> link + campo do codigo -> sucesso.
 *
 * Fluxo:
 *   starting   telas do 1o uso (tema, metodo de login, ...) passadas sozinhas
 *   url        link OAuth na tela: o painel mostra o link e o campo do codigo
 *   code-sent  codigo colado, o Claude esta validando
 *   finishing  login OK: passa as telas pos-login (notas de seguranca, terminal, pasta confiavel,
 *              aviso do modo bypass) ate o prompt do Claude ficar pronto
 *   success    pronto: encerra a sessao e reinicia os projetos parados na tela de login
 *   attention  ULTIMO recurso: tela desconhecida que nao saiu com Enter (ou cujo default e "sair")
 *              — o painel mostra a tela e as teclas. A tela vai pro log ("login: unknown screen")
 *              para virar uma linha nova na tabela.
 *
 * Telas desconhecidas: espera a tela ficar parada UNKNOWN_STABLE_MS, e se a opcao selecionada nao
 * for de saida ("No, exit", "Cancel"...) tenta Enter ate UNKNOWN_MAX_ENTERS vezes por tela.
 *
 * Claude Code novo mudou um texto? Ajuste so a tabela SCREENS (e o `claude` falso do smoke test).
 */
const cfg = require('./config');
const { sh, paneOf, log } = require('./util');
const { loginInfo } = require('./claude');

const SESS = 'cr-login';
const PANE = paneOf(SESS);
const MAX_MS = 15 * 60 * 1000;
const ACT_GAP_MS = 1200; // respiro entre acoes p/ a TUI redesenhar
const REPEAT_GAP_MS = 3000; // repetir a MESMA tecla na MESMA tela so depois disso
const UNKNOWN_STABLE_MS = 4000;
const UNKNOWN_MAX_ENTERS = 3;
const SAME_ACTION_MAX = 8; // mesma tela + mesma tecla N vezes sem mudar -> travou -> attention

/*
 * Telas interativas conhecidas (Claude Code 2.1.x, conferidas ao vivo na 2.1.332). A 1a que casar
 * vence, entao as mais especificas vem antes. Campos:
 *   id        nome curto (log / estado)
 *   match     RegExp testada na tela visivel
 *   key       tecla a enviar (nome do tmux send-keys: Enter, Down, Escape, 1...)
 *   select    OU RegExp da opcao a escolher: move o cursor (❯) ate ela e da Enter
 *   loggedIn  esta tela prova que o login deu certo
 */
const SCREENS = [
  { id: 'login-success', match: /Login successful|Logged in (successfully|as)|Successfully logged in/i, key: 'Enter', loggedIn: true },
  { id: 'theme', match: /Choose the text style|text style that looks best/i, key: 'Enter' },
  { id: 'login-method', match: /Select login method/i, select: /Claude account with subscription/i },
  // ANTHROPIC_API_KEY no ambiente: "No (recommended)" mantem o login por conta
  { id: 'api-key', match: /Detected a custom API key/i, select: /No \(recommended\)/i },
  { id: 'security-notes', match: /Security notes/i, key: 'Enter' },
  { id: 'terminal-setup', match: /terminal setup\?|Use Claude Code's terminal setup/i, select: /No, maybe later/i },
  // default e "No, exit": Enter fecharia o Claude
  { id: 'trust-folder', match: /Is this a project you created or one you trust|Yes, I trust this folder|Do you trust the files/i, select: /Yes, I trust/i },
  // o dev-box roda em bypassPermissions de proposito (managed-settings.json); default e "No, exit"
  { id: 'bypass-warning', match: /running in Bypass Permissions mode/i, select: /Yes, I accept/i },
  { id: 'press-enter', match: /Press Enter to continue/i, key: 'Enter' },
];
// estados que NAO sao respondidos com teclas
const URL_RX = /https:\/\/[^\s"'<>]*(?:oauth|authorize)[^\s"'<>]*/gi;
const REPL_RX = /\? for shortcuts|bypass permissions on|shift\+tab to cycle/i;
const ERROR_RX = /OAuth error|Login failed|Invalid (code|authorization)|Request failed|timed out/i;
const PASTE_RX = /Paste (the )?code|Paste code here|authorization code/i;
const CURSOR_RX = /^\s*[❯›]\s*\S/;
const EXIT_OPTION_RX = /\b(exit|quit|cancel|decline|reject|never mind)\b|^\s*[❯›]\s*(\d+\.\s*)?No\b/i;

const lastLines = (s, n) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

// tecla p/ levar o cursor ate a opcao `target` (null = opcao/cursor nao achados)
function selectKey(screen, target) {
  const lines = screen.split('\n');
  const cur = lines.findIndex((l) => CURSOR_RX.test(l));
  let want = -1;
  lines.forEach((l, i) => { if (target.test(l)) want = i; });
  if (cur < 0 || want < 0) return null;
  if (cur === want) return 'Enter';
  return want > cur ? 'Down' : 'Up';
}
// a opcao selecionada fecharia o Claude? (Enter as cegas seria perigoso)
function exitSelected(screen) {
  const l = screen.split('\n').find((x) => CURSOR_RX.test(x));
  return !!l && EXIT_OPTION_RX.test(l);
}

// Decide o que fazer com a tela (funcao PURA — testada direto no smoke test com telas reais).
//   { kind: 'screen', id, key, loggedIn }  tela conhecida -> enviar `key`
//   { kind: 'url', url } | { kind: 'repl' } | { kind: 'unknown', exitSelected } | { kind: 'blank' }
function classify(screen) {
  if (!screen.trim()) return { kind: 'blank' };
  for (const s of SCREENS) {
    if (!s.match.test(screen)) continue;
    const key = s.select ? selectKey(screen, s.select) : s.key;
    if (!key) break; // casou, mas a opcao sumiu: trata como desconhecida
    return { kind: 'screen', id: s.id, key, loggedIn: !!s.loggedIn };
  }
  const url = (screen.match(URL_RX) || []).pop();
  if (url) return { kind: 'url', url };
  if (REPL_RX.test(screen)) return { kind: 'repl' };
  return { kind: 'unknown', exitSelected: exitSelected(screen) };
}

let st = idle();
let timer = null;
function idle() {
  return {
    phase: 'idle', step: '', url: '', msg: '', screen: '', startedAt: 0, lastActAt: 0,
    wasLogged: false, loggedIn: false, sentLogin: false, sentLoginAt: 0, codeAt: 0,
    sig: '', sigSince: 0, unknownEnters: {}, lastAction: '', sameCount: 0,
  };
}

const hasSess = async () => (await sh('tmux', ['has-session', '-t', '=' + SESS])).ok;
// so a tela VISIVEL: texto antigo no scrollback (ex.: um "Select login method" ja passado) nao casa de novo
const capture = async () => {
  const r = await sh('tmux', ['capture-pane', '-t', PANE, '-p', '-J']);
  return r.ok ? r.stdout.replace(/\s+$/g, '') : '';
};
const keys = (...k) => sh('tmux', ['send-keys', '-t', PANE, ...k]);

// uma acao por vez, com respiro; a mesma acao na mesma tela repetida demais = travou
function act(sig, what, fn) {
  if (Date.now() - st.lastActAt < ACT_GAP_MS) return true;
  const a = sig + '|' + what;
  // mesma tecla na MESMA tela: a TUI pode so estar lenta p/ redesenhar — um Enter repetido cedo
  // demais cairia na tela SEGUINTE (ex.: "No, exit" da pasta confiavel)
  if (a === st.lastAction && Date.now() - st.lastActAt < REPEAT_GAP_MS) return true;
  st.sameCount = a === st.lastAction ? st.sameCount + 1 : 0;
  st.lastAction = a;
  if (st.sameCount >= SAME_ACTION_MAX) return false;
  st.lastActAt = Date.now();
  fn();
  return true;
}

// assinatura da tela sem spinners/relogios: muda so quando o conteudo muda
const signature = (screen) => lastLines(screen, 15).replace(/[✻✶✳✢·*◐◓◑◒⠁-⣿]/g, '').replace(/\d+s\b/g, '');

function attention(screen, why) {
  if (st.phase !== 'attention') log('warn', 'login: unknown screen', { why, screen: lastLines(screen, 20) });
  st.phase = 'attention';
}

async function finish(msg) {
  st.phase = 'success'; st.msg = msg || 'login complete'; st.url = '';
  stopTimer();
  log('info', 'login do Claude concluido');
  setTimeout(async () => { await sh('tmux', ['kill-session', '-t', '=' + SESS]); await restartStuckProjects(); }, 1500);
}

async function fail(msg) {
  stopTimer();
  st.phase = 'error'; st.msg = msg;
  await sh('tmux', ['kill-session', '-t', '=' + SESS]);
}

async function tick() {
  if (!['starting', 'url', 'code-sent', 'finishing', 'attention'].includes(st.phase)) return;
  if (Date.now() - st.startedAt > MAX_MS) { await cancel('timed out (15 min) — start again'); return; }
  if (!(await hasSess())) {
    if (st.loggedIn || (st.codeAt && loginInfo().logged)) return finish();
    stopTimer();
    st.phase = 'error'; st.msg = 'Claude Code closed before the login finished';
    return;
  }
  const screen = await capture();
  st.screen = lastLines(screen, 40);
  // credencial nova gravada = login ok, mesmo se a tela "Login successful" passou rapido demais
  if (!st.loggedIn && st.codeAt && !st.wasLogged && loginInfo().logged) st.loggedIn = true;
  if (st.codeAt && !st.loggedIn && ERROR_RX.test(lastLines(screen, 8))) {
    return fail('Claude rejected the code — generate a new link and try again');
  }

  const sig = signature(screen);
  if (sig !== st.sig) { st.sig = sig; st.sigSince = Date.now(); }
  const c = classify(screen);

  if (c.kind === 'screen') {
    if (c.loggedIn) st.loggedIn = true;
    st.step = c.id;
    st.phase = st.loggedIn ? 'finishing' : 'starting';
    const ok = act(sig, c.key, () => keys(c.key));
    if (!ok) attention(screen, `screen "${c.id}" did not change after ${SAME_ACTION_MAX} tries`);
    return;
  }
  if (c.kind === 'url' && !st.loggedIn) {
    st.url = c.url; st.step = 'url';
    st.phase = st.codeAt ? 'code-sent' : 'url';
    return;
  }
  if (c.kind === 'repl') {
    if (st.loggedIn) return finish();
    // ja logado (troca de conta): abre o /login uma vez
    if (!st.sentLogin) {
      st.sentLogin = true; st.sentLoginAt = Date.now(); st.step = 'login-command'; st.phase = 'starting';
      act(sig, '/login', async () => { await keys('-l', '/login'); setTimeout(() => keys('Enter'), 500); });
    } else if (Date.now() - st.sentLoginAt > 20000) {
      await fail('could not open /login in Claude Code — try again');
    }
    return;
  }
  if (c.kind === 'blank' || c.kind === 'url') return; // carregando / link velho saindo da tela
  // desconhecida: espera parar; Enter (se a opcao marcada nao for "sair") ate N vezes
  const settle = st.phase === 'code-sent' && !st.loggedIn ? 15000 : UNKNOWN_STABLE_MS;
  if (Date.now() - st.sigSince < settle) return;
  if (c.exitSelected) return attention(screen, 'selected option would exit');
  const n = st.unknownEnters[sig] || 0;
  if (n >= UNKNOWN_MAX_ENTERS) return attention(screen, `Enter did not pass it (${n}x)`);
  if (Date.now() - st.lastActAt < UNKNOWN_STABLE_MS) return;
  st.unknownEnters[sig] = n + 1;
  st.lastActAt = Date.now();
  log('warn', 'login: unknown screen — trying Enter', { try: n + 1, screen: lastLines(screen, 20) });
  await keys('Enter');
}

function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

async function start() {
  stopTimer();
  await sh('tmux', ['kill-session', '-t', '=' + SESS]);
  const r = await sh('tmux', ['new-session', '-d', '-s', SESS, '-x', '500', '-y', '50', '-c', cfg.HOME, 'claude']);
  if (!r.ok) { st = { ...idle(), phase: 'error', msg: tr('srv.loginStartFailed') + r.stderr.trim() }; return status(); }
  // largura FIXA: sem cliente anexado a janela nunca encolhe
  await sh('tmux', ['set-option', '-t', '=' + SESS, 'window-size', 'manual']);
  await sh('tmux', ['set-option', '-t', '=' + SESS, 'status', 'off']);
  st = { ...idle(), phase: 'starting', startedAt: Date.now(), wasLogged: loginInfo().logged };
  timer = setInterval(() => { tick().catch((e) => log('error', 'login tick', { err: e.message })); }, 1000);
  timer.unref();
  log('info', 'login do Claude iniciado');
  return status();
}

async function sendCode(code) {
  const c = String(code || '').trim();
  if (!c || c.length > 2000 || /[\x00-\x1f\x7f]/.test(c)) return { ok: false, msg: tr('srv.badCode') };
  if (!(await hasSess())) return { ok: false, msg: tr('srv.noLoginTap') };
  await keys('-l', c);
  await new Promise((r) => setTimeout(r, 400));
  await keys('Enter');
  st.codeAt = Date.now(); st.phase = 'code-sent'; st.msg = ''; st.lastActAt = Date.now();
  return { ok: true, msg: tr('srv.codeSent') };
}

// teclas manuais p/ a fase "attention" (ultimo recurso)
const KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', '1', '2', '3']);
async function sendKey(key) {
  if (!KEYS.has(key)) return { ok: false, msg: tr('srv.keyNotAllowed') };
  if (!(await hasSess())) return { ok: false, msg: tr('srv.noLogin') };
  await keys(key);
  st.lastActAt = Date.now();
  return { ok: true };
}

async function cancel(msg) {
  stopTimer();
  await sh('tmux', ['kill-session', '-t', '=' + SESS]);
  st = { ...idle(), msg: msg || '' };
  return { ok: true, msg: msg || 'login cancelled' };
}

function status() {
  // a tela crua so interessa quando o dono precisa agir
  const screen = st.phase === 'attention' || st.phase === 'error' ? st.screen : '';
  return { ok: true, phase: st.phase, step: st.step, url: st.url, msg: st.msg, screen, logged: loginInfo().logged };
}

// Projetos cujo Claude subiu ANTES do login ficam parados nas telas de 1o uso/login: reinicia so
// esses (os que ja estavam trabalhando nao sao tocados).
const STUCK_IDS = new Set(['theme', 'login-method', 'api-key']);
async function restartStuckProjects() {
  try {
    const projects = require('./projects'); // lazy: evita ciclo de require
    for (const name of projects.listProjects()) {
      const sess = require('./util').sessionName(name);
      const r = await sh('tmux', ['capture-pane', '-t', paneOf(sess), '-p', '-J']);
      if (!r.ok) continue;
      const c = classify(r.stdout);
      if ((c.kind === 'screen' && STUCK_IDS.has(c.id)) || PASTE_RX.test(r.stdout)) {
        log('info', 'reiniciando projeto parado na tela de login', { name });
        await projects.recreateSession(name);
      }
    }
    require('./events').poke();
  } catch (e) { log('error', 'restartStuckProjects', { err: e.message }); }
}

module.exports = { start, sendCode, sendKey, cancel, status, classify, SCREENS, SESSION: SESS };
