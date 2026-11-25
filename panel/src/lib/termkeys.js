// Terminal keys on the phone — PURE logic (no DOM/React), tested in node (test/unit.mjs).
//
// - EXTRA_KEYS: the extra keys bar (Esc, Tab, Ctrl, Alt, arrows, ^C, Enter, / | ~ -, paste).
// - CLAUDE_ACTIONS: one-tap shortcuts for Claude Code (Esc, Shift+Tab = mode, 1/2/3 =
//   answer the question, /remote-control).
// - "Sticky" Ctrl/Alt: tapping Ctrl and then a letter on the phone keyboard sends
//   Ctrl+letter. 1 tap = only the next key; 2 taps = locked; 3rd tap = off.
// - applyModifiers(): applies Ctrl/Alt to what the phone keyboard typed (raw xterm text).
// - touchScroll(): turns the finger drag into scroll "lines" (tmux mouse wheel).

export const ESC = '\x1b'
export const SEQ = {
  esc: ESC,
  tab: '\t',
  shiftTab: ESC + '[Z',
  enter: '\r',
  up: ESC + '[A',
  down: ESC + '[B',
  right: ESC + '[C',
  left: ESC + '[D',
  home: ESC + '[H',
  end: ESC + '[F',
  pgUp: ESC + '[5~',
  pgDn: ESC + '[6~',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlZ: '\x1a',
  ctrlL: '\x0c',
  ctrlR: '\x12',
}

// kind: 'seq' sends the sequence | 'mod' turns a modifier on/off | 'action' (paste...)
// repeat: holding the button repeats (arrows)
export const EXTRA_KEYS = [
  { id: 'esc', label: 'Esc', seq: SEQ.esc, title: 'Escape' },
  { id: 'tab', label: 'Tab', seq: SEQ.tab, title: 'Tab' },
  { id: 'ctrl', label: 'Ctrl', mod: 'ctrl', title: 'Ctrl: tap = next key, tap twice = lock' },
  { id: 'alt', label: 'Alt', mod: 'alt', title: 'Alt: tap = next key, tap twice = lock' },
  { id: 'ctrlc', label: '^C', seq: SEQ.ctrlC, title: 'Ctrl+C (interrupt)' },
  { id: 'left', label: '←', seq: SEQ.left, repeat: true, title: 'Left' },
  { id: 'up', label: '↑', seq: SEQ.up, repeat: true, title: 'Up' },
  { id: 'down', label: '↓', seq: SEQ.down, repeat: true, title: 'Down' },
  { id: 'right', label: '→', seq: SEQ.right, repeat: true, title: 'Right' },
  { id: 'enter', label: '⏎', seq: SEQ.enter, title: 'Enter' },
  { id: 'slash', label: '/', seq: '/', title: '/' },
  { id: 'pipe', label: '|', seq: '|', title: '|' },
  { id: 'tilde', label: '~', seq: '~', title: '~' },
  { id: 'dash', label: '-', seq: '-', title: '-' },
  { id: 'home', label: 'Home', seq: SEQ.home, title: 'Home' },
  { id: 'end', label: 'End', seq: SEQ.end, title: 'End' },
  { id: 'pgup', label: 'PgUp', seq: SEQ.pgUp, repeat: true, title: 'Page Up' },
  { id: 'pgdn', label: 'PgDn', seq: SEQ.pgDn, repeat: true, title: 'Page Down' },
  { id: 'ctrld', label: '^D', seq: SEQ.ctrlD, title: 'Ctrl+D (EOF / exit shell)' },
  { id: 'ctrlr', label: '^R', seq: SEQ.ctrlR, title: 'Ctrl+R (history search)' },
  { id: 'ctrll', label: '^L', seq: SEQ.ctrlL, title: 'Ctrl+L (clear screen)' },
  { id: 'paste', label: 'Paste', action: 'paste', title: 'Paste from clipboard' },
]

// Claude Code shortcuts (only in project sessions)
export const CLAUDE_ACTIONS = [
  { id: 'esc', label: 'Esc', seq: SEQ.esc, title: 'Esc: stop Claude / cancel' },
  { id: 'mode', label: '⇧Tab mode', seq: SEQ.shiftTab, title: 'Shift+Tab: cycle mode (normal / auto-accept / plan)' },
  { id: 'a1', label: '1', seq: '1', title: 'Answer 1 (Yes)' },
  { id: 'a2', label: '2', seq: '2', title: 'Answer 2' },
  { id: 'a3', label: '3', seq: '3', title: 'Answer 3 (No)' },
  { id: 'enter', label: 'Enter', seq: SEQ.enter, title: 'Enter: confirm' },
  { id: 'rc', label: '/remote-control', seq: '/remote-control' + SEQ.enter, title: 'Type /remote-control + Enter' },
]

// ---------- sticky modifiers ----------
// state: 'off' -> 'once' (only the next key) -> 'lock' (until turned off) -> 'off'
export function cycleMod(state) {
  return state === 'off' || !state ? 'once' : state === 'once' ? 'lock' : 'off'
}
// after use: 'once' goes back to 'off'; 'lock' stays
export const afterUse = (state) => (state === 'lock' ? 'lock' : 'off')

// Ctrl + 1 character -> control byte (or null if that key has no Ctrl)
export function ctrlChar(ch) {
  if (!ch || ch.length !== 1) return null
  const c = ch.charCodeAt(0)
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96) // a-z
  if (c >= 65 && c <= 90) return String.fromCharCode(c - 64) // A-Z
  const map = { '@': '\x00', ' ': '\x00', '2': '\x00', '[': ESC, '3': ESC, '\\': '\x1c', '4': '\x1c', ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '7': '\x1f', '/': '\x1f', '?': '\x7f', '8': '\x7f' }
  return map[ch] ?? null
}

// cursor/editing CSI (arrows, Home/End, PgUp/PgDn) with an xterm modifier:
// ESC [ A -> ESC [ 1 ; m A   e   ESC [ 5 ~ -> ESC [ 5 ; m ~   (m = 1 + shift(1) + alt(2) + ctrl(4))
function modifyCsi(seq, m) {
  let r = /^\x1b\[([ABCDHF])$/.exec(seq) || /^\x1bO([ABCDHF])$/.exec(seq)
  if (r) return `${ESC}[1;${m}${r[1]}`
  r = /^\x1b\[(\d+)~$/.exec(seq)
  if (r) return `${ESC}[${r[1]};${m}~`
  return null
}

// Applies Ctrl/Alt to the typed text. mods = { ctrl: bool, alt: bool }.
// Only the FIRST "key press" is modified (the rest of a pasted/IME text passes untouched).
export function applyModifiers(data, mods = {}) {
  if (!data || (!mods.ctrl && !mods.alt)) return data
  if (data.charCodeAt(0) === 27 && data.length > 1) {
    const m = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
    const csi = modifyCsi(data, m)
    if (csi) return csi
    return data // another escape sequence: leave it alone
  }
  // first character (careful with surrogate pairs/emoji: they have no Ctrl)
  const first = String.fromCodePoint(data.codePointAt(0))
  const rest = data.slice(first.length)
  let out = first
  if (mods.ctrl) {
    const c = ctrlChar(first)
    if (c !== null) out = c
  }
  if (mods.alt) out = ESC + out
  return out + rest
}

// ---------- fonte ----------
export const FONT_MIN = 8
export const FONT_MAX = 28
export const clampFont = (n, d = 13) => {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(FONT_MAX, Math.max(FONT_MIN, v)) : d
}
// initial font: the one saved by the user, otherwise a smaller one on the phone (fits ~45 columns in 390px)
export const defaultFont = (narrow) => (narrow ? 12 : 13)

// ---------- rolagem por toque ----------
// dy = finger offset (px, + = finger went down = scroll UP in the history), cell = line
// height (px), carry = leftover accumulated from the previous drag. Returns { lines, carry }:
// lines > 0 = scroll up (history), < 0 = down.
export function touchScroll(dy, cell, carry = 0) {
  const h = cell > 0 ? cell : 16
  const total = carry + dy
  const lines = Math.trunc(total / h)
  return { lines, carry: total - lines * h }
}

// xterm also sends AUTOMATIC answers to the program through onData (mouse report, focus,
// cursor position, terminal attributes). They are not the user's "next key": the sticky
// Ctrl must not be applied to nor spent on them.
export function isUserInput(data) {
  if (!data) return false
  return !/^\x1b\[(<[\d;]+[Mm]|M[\s\S]{3}|[IO]|\d+;\d+R|[?>][\d;]*c)$/.test(data)
}

// virtual keyboard open? (visible height much smaller than the window's "full" height)
export const keyboardOpen = (visibleH, fullH) => fullH > 0 && visibleH > 0 && fullH - visibleH > 120
