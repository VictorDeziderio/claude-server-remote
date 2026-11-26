'use strict';
const { tr } = require('./i18n');
/*
 * Claude Code login GUIDED by the panel (Account -> Connect Claude).
 *
 * Runs `claude` (TUI) in a dedicated tmux session (cr-login) that is WIDE (500 columns, nobody attaches) —
 * so the OAuth link never wraps into several lines and comes out whole to copy. A "pilot" reads the
 * VISIBLE screen every second and answers by itself ALL the known screens, before and after the
 * login (SCREENS table below). The owner only sees: progress -> link + code field -> success.
 *
 * Flow:
 *   starting   first-run screens (theme, login method, ...) passed by themselves
 *   url        OAuth link on screen: the panel shows the link and the code field
 *   code-sent  code pasted, Claude is validating it
 *   finishing  login OK: passes the post-login screens (security notes, terminal, trusted folder,
 *              bypass mode warning) until Claude's prompt is ready
 *   success    done: closes the session and restarts the projects stuck on the login screen
 *   attention  LAST resort: an unknown screen that did not go away with Enter (or whose default is "exit")
 *              — the panel shows the screen and the keys. The screen goes to the log ("login: unknown screen")
 *              to become a new line in the table.
 *
 * Unknown screens: waits for the screen to stay still UNKNOWN_STABLE_MS, and if the selected option is not
 * an exit ("No, exit", "Cancel"...) tries Enter up to UNKNOWN_MAX_ENTERS times per screen.
 *
 * A new Claude Code changed a text? Adjust only the SCREENS table (and the fake `claude` of the smoke test).
 *
 * Accounts (server/accounts.js): start(account) logs THAT account in — the login session runs with
 * its CLAUDE_CONFIG_DIR (nothing for "default"), so the credentials land in its own config dir.
 * One login at a time (one cr-login session).
 */
const cfg = require('./config');
const { sh, paneOf, log } = require('./util');
const { loginInfo } = require('./claude');
const accounts = require('./accounts');

const SESS = 'cr-login';
const PANE = paneOf(SESS);
const MAX_MS = 15 * 60 * 1000;
const ACT_GAP_MS = 1200; // pause between actions for the TUI to redraw
const REPEAT_GAP_MS = 3000; // repeat the SAME key on the SAME screen only after this
const UNKNOWN_STABLE_MS = 4000;
const UNKNOWN_MAX_ENTERS = 3;
const SAME_ACTION_MAX = 8;
const REPL_SETTLE_MS = Number(process.env.LOGIN_REPL_SETTLE_MS) || 2500; // prompt still this long before typing /login
const LOGIN_RETRY_MS = Number(process.env.LOGIN_RETRY_MS) || 7000;     // /login again when the menu did not open
const LOGIN_TRIES = 3; // same screen + same key N times with no change -> stuck -> attention

/*
 * Known interactive screens (Claude Code 2.1.x, checked live on 2.1.332). The first match
 * wins, so the most specific ones come first. Fields:
 *   id        short name (log / state)
 *   match     RegExp tested on the visible screen
 *   key       key to send (tmux send-keys name: Enter, Down, Escape, 1...)
 *   select    OR RegExp of the option to choose: moves the cursor (❯) to it and presses Enter
 *   loggedIn  this screen proves the login worked
 */
const SCREENS = [
  { id: 'login-success', match: /Login successful|Logged in (successfully|as)|Successfully logged in/i, key: 'Enter', loggedIn: true },
  { id: 'theme', match: /Choose the text style|text style that looks best/i, key: 'Enter' },
  { id: 'login-method', match: /Select login method/i, select: /Claude account with subscription/i },
  // ANTHROPIC_API_KEY in the environment: "No (recommended)" keeps the account login
  { id: 'api-key', match: /Detected a custom API key/i, select: /No \(recommended\)/i },
  { id: 'security-notes', match: /Security notes/i, key: 'Enter' },
  { id: 'terminal-setup', match: /terminal setup\?|Use Claude Code's terminal setup/i, select: /No, maybe later/i },
  // the default is "No, exit": Enter would close Claude
  { id: 'trust-folder', match: /Is this a project you created or one you trust|Yes, I trust this folder|Do you trust the files/i, select: /Yes, I trust/i },
  // the dev box runs in bypassPermissions on purpose (managed-settings.json); the default is "No, exit"
  { id: 'bypass-warning', match: /running in Bypass Permissions mode/i, select: /Yes, I accept/i },
  { id: 'press-enter', match: /Press Enter to continue/i, key: 'Enter' },
];
// states that are NOT answered with keys
const URL_RX = /https:\/\/[^\s"'<>]*(?:oauth|authorize)[^\s"'<>]*/gi;
const REPL_RX = /\? for shortcuts|bypass permissions on|shift\+tab to cycle/i;
const ERROR_RX = /OAuth error|Login failed|Invalid (code|authorization)|Request failed|timed out/i;
const PASTE_RX = /Paste (the )?code|Paste code here|authorization code/i;
const CURSOR_RX = /^\s*[❯›]\s*\S/;
const EXIT_OPTION_RX = /\b(exit|quit|cancel|decline|reject|never mind)\b|^\s*[❯›]\s*(\d+\.\s*)?No\b/i;

const lastLines = (s, n) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

// key to bring the cursor to the `target` option (null = option/cursor not found)
// The menu's cursor is the LAST ❯ line: /login opens its menu under the prompt, whose own line
// ("❯ /login") also starts with ❯ and must not be taken for the selected option.
const cursorLine = (lines) => { for (let i = lines.length - 1; i >= 0; i--) if (CURSOR_RX.test(lines[i])) return i; return -1; };
function selectKey(screen, target) {
  const lines = screen.split('\n');
  const cur = cursorLine(lines);
  let want = -1;
  lines.forEach((l, i) => { if (target.test(l)) want = i; });
  if (cur < 0 || want < 0) return null;
  if (cur === want) return 'Enter';
  return want > cur ? 'Down' : 'Up';
}
// a opcao selecionada fecharia o Claude? (Enter as cegas seria perigoso)
function exitSelected(screen) {
  const lines = screen.split('\n');
  const l = lines[cursorLine(lines)];
  return !!l && EXIT_OPTION_RX.test(l);
}

// Decides what to do with the screen (PURE function — tested directly in the smoke test with real screens).
//   { kind: 'screen', id, key, loggedIn }  known screen -> send `key`
//   { kind: 'url', url } | { kind: 'repl' } | { kind: 'unknown', exitSelected } | { kind: 'blank' }
function classify(screen) {
  if (!screen.trim()) return { kind: 'blank' };
  for (const s of SCREENS) {
    if (!s.match.test(screen)) continue;
    const key = s.select ? selectKey(screen, s.select) : s.key;
    if (!key) break; // matched, but the option is gone: treat as unknown
    return { kind: 'screen', id: s.id, key, loggedIn: !!s.loggedIn };
  }
  const url = (screen.match(URL_RX) || []).pop();
  if (url) return { kind: 'url', url };
  if (REPL_RX.test(screen)) return { kind: 'repl' };
  return { kind: 'unknown', exitSelected: exitSelected(screen) };
}

let st = idle();
let timer = null;
// the OAuth code pasted by the owner (kept only in memory, only to mask it): it may still be on
// screen (the input line) when an unknown screen is written to the panel log or shown back
let sentCode = '';
// screen text that is safe to log/show: once a code was sent, the code itself and any line of the
// "paste code" prompt are masked (the panel log is readable from the Logs page and kept on disk)
function safeScreen(screen) {
  let s = String(screen || '');
  if (!st.codeAt && !sentCode) return s;
  if (sentCode) s = s.split(sentCode).join('[code hidden]');
  return s.split('\n').map((l) => (PASTE_RX.test(l) ? '[code prompt hidden]' : l)).join('\n');
}
function idle() {
  return {
    phase: 'idle', step: '', url: '', msg: '', screen: '', startedAt: 0, lastActAt: 0,
    account: accounts.DEFAULT, wasLogged: false, loggedIn: false, sentLogin: false, sentLoginAt: 0, loginTries: 0, codeAt: 0,
    sig: '', sigSince: 0, unknownEnters: {}, lastAction: '', sameCount: 0,
  };
}

const hasSess = async () => (await sh('tmux', ['has-session', '-t', '=' + SESS])).ok;
// only the VISIBLE screen: old text in the scrollback (e.g. a "Select login method" already passed) does not match again
const capture = async () => {
  const r = await sh('tmux', ['capture-pane', '-t', PANE, '-p', '-J']);
  return r.ok ? r.stdout.replace(/\s+$/g, '') : '';
};
const keys = (...k) => sh('tmux', ['send-keys', '-t', PANE, ...k]);

// one action at a time, with a pause; the same action on the same screen repeated too often = stuck
function act(sig, what, fn) {
  if (Date.now() - st.lastActAt < ACT_GAP_MS) return true;
  const a = sig + '|' + what;
  // same key on the SAME screen: the TUI may just be slow to redraw — an Enter repeated too
  // early would land on the NEXT screen (e.g. "No, exit" of the trusted folder)
  if (a === st.lastAction && Date.now() - st.lastActAt < REPEAT_GAP_MS) return true;
  st.sameCount = a === st.lastAction ? st.sameCount + 1 : 0;
  st.lastAction = a;
  if (st.sameCount >= SAME_ACTION_MAX) return false;
  st.lastActAt = Date.now();
  fn();
  return true;
}

// signature of the screen without spinners/clocks: changes only when the content changes
const signature = (screen) => lastLines(screen, 15).replace(/[✻✶✳✢·*◐◓◑◒⠁-⣿]/g, '').replace(/\d+s\b/g, '');

function attention(screen, why) {
  if (st.phase !== 'attention') log('warn', 'login: unknown screen', { why, screen: safeScreen(lastLines(screen, 20)) });
  st.phase = 'attention';
}

async function finish(msg) {
  st.phase = 'success'; st.msg = msg || 'login complete'; st.url = '';
  stopTimer();
  log('info', 'login do Claude concluido', { account: st.account });
  // a NEW login started in these 1.5s (e.g. the next account right away) owns cr-login now: not killed
  const gen = st.startedAt, account = st.account;
  setTimeout(async () => {
    if (st.startedAt === gen) await sh('tmux', ['kill-session', '-t', '=' + SESS]);
    await restartStuckProjects(account);
  }, 1500);
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
    if (st.loggedIn || (st.codeAt && loginInfo(st.account).logged)) return finish();
    stopTimer();
    st.phase = 'error'; st.msg = 'Claude Code closed before the login finished';
    return;
  }
  const screen = await capture();
  st.screen = safeScreen(lastLines(screen, 40));
  // new credential saved = login ok, even if the "Login successful" screen went by too fast
  if (!st.loggedIn && st.codeAt && !st.wasLogged && loginInfo(st.account).logged) st.loggedIn = true;
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
    // at the prompt without the login menu (already logged in, or a new account whose onboarding
    // flags were copied): type /login. Claude Code drops keys typed while it is still loading, so
    // wait for the screen to stand still first, and type it again if the menu did not open.
    if (Date.now() - st.sigSince < REPL_SETTLE_MS) return;
    if (st.loginTries >= LOGIN_TRIES && Date.now() - st.sentLoginAt > LOGIN_RETRY_MS) {
      return fail('could not open /login in Claude Code — try again');
    }
    if (st.loginTries && Date.now() - st.sentLoginAt < LOGIN_RETRY_MS) return;
    st.loginTries = (st.loginTries || 0) + 1; st.sentLogin = true; st.sentLoginAt = Date.now();
    st.step = 'login-command'; st.phase = 'starting';
    // clears whatever is on the input line, types the command, then Enter once the menu of
    // commands is drawn (an Enter too early picks nothing)
    await keys('C-u');
    await keys('-l', '/login');
    setTimeout(() => keys('Enter'), 1200);
    return;
  }
  if (c.kind === 'blank' || c.kind === 'url') return; // loading / old link leaving the screen
  // unknown: wait for it to stand still; Enter (if the marked option is not "exit") up to N times
  const settle = st.phase === 'code-sent' && !st.loggedIn ? 15000 : UNKNOWN_STABLE_MS;
  if (Date.now() - st.sigSince < settle) return;
  if (c.exitSelected) return attention(screen, 'selected option would exit');
  const n = st.unknownEnters[sig] || 0;
  if (n >= UNKNOWN_MAX_ENTERS) return attention(screen, `Enter did not pass it (${n}x)`);
  if (Date.now() - st.lastActAt < UNKNOWN_STABLE_MS) return;
  st.unknownEnters[sig] = n + 1;
  st.lastActAt = Date.now();
  log('warn', 'login: unknown screen — trying Enter', { try: n + 1, screen: safeScreen(lastLines(screen, 20)) });
  await keys('Enter');
}

function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

async function start(accountIn) {
  const account = accountIn || accounts.DEFAULT;
  if (!accounts.exists(account)) return { ok: false, msg: tr('srv.acct.none'), phase: 'error' };
  stopTimer();
  sentCode = '';
  await sh('tmux', ['kill-session', '-t', '=' + SESS]);
  await accounts.prepare(account);
  // -e: the account's config dir for this session only (a tmux server may already be running with another env)
  const env = Object.entries(accounts.envOf(account)).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = await sh('tmux', ['new-session', '-d', ...env, '-s', SESS, '-x', '500', '-y', '50', '-c', cfg.HOME, 'claude']);
  if (!r.ok) { st = { ...idle(), phase: 'error', msg: tr('srv.loginStartFailed') + r.stderr.trim() }; return status(); }
  // FIXED width: with no client attached the window never shrinks
  await sh('tmux', ['set-option', '-t', '=' + SESS, 'window-size', 'manual']);
  await sh('tmux', ['set-option', '-t', '=' + SESS, 'status', 'off']);
  st = { ...idle(), phase: 'starting', startedAt: Date.now(), account, wasLogged: loginInfo(account).logged };
  timer = setInterval(() => { tick().catch((e) => log('error', 'login tick', { err: e.message })); }, 1000);
  timer.unref();
  log('info', 'login do Claude iniciado', { account });
  return status();
}

async function sendCode(code) {
  const c = String(code || '').trim();
  if (!c || c.length > 2000 || /[\x00-\x1f\x7f]/.test(c)) return { ok: false, msg: tr('srv.badCode') };
  if (!(await hasSess())) return { ok: false, msg: tr('srv.noLoginTap') };
  sentCode = c;
  await keys('-l', c);
  await new Promise((r) => setTimeout(r, 400));
  await keys('Enter');
  st.codeAt = Date.now(); st.phase = 'code-sent'; st.msg = ''; st.lastActAt = Date.now();
  return { ok: true, msg: tr('srv.codeSent') };
}

// manual keys for the "attention" phase (last resort)
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
  sentCode = '';
  return { ok: true, msg: msg || 'login cancelled' };
}

function status() {
  // the raw screen only matters when the owner needs to act
  const screen = st.phase === 'attention' || st.phase === 'error' ? st.screen : '';
  return { ok: true, phase: st.phase, step: st.step, url: st.url, msg: st.msg, screen, account: st.account, logged: loginInfo(st.account).logged };
}

// Projects whose Claude started BEFORE the login are stuck on the first-run/login screens: restarts only
// those of the account that just logged in (the ones that were already working are not touched).
const STUCK_IDS = new Set(['theme', 'login-method', 'api-key']);
async function restartStuckProjects(account) {
  try {
    const projects = require('./projects'); // lazy: avoids a require cycle
    for (const name of projects.listProjects()) {
      if ((projects.projConfig(name).account || accounts.DEFAULT) !== account) continue;
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

module.exports = { start, sendCode, sendKey, cancel, status, classify, SCREENS, SESSION: SESS, _safeScreen: safeScreen, _setSentCode: (c) => { sentCode = c; } };
