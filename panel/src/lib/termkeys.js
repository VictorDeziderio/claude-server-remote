// Teclas do terminal no celular — logica PURA (sem DOM/React), testada em node (test/unit.mjs).
//
// - EXTRA_KEYS: a barra de teclas extras (Esc, Tab, Ctrl, Alt, setas, ^C, Enter, / | ~ -, colar).
// - CLAUDE_ACTIONS: atalhos de um toque para o Claude Code (Esc, Shift+Tab = modo, 1/2/3 =
//   responder a pergunta, /remote-control).
// - Ctrl/Alt "grudentos" (sticky): tocar Ctrl e depois uma letra do teclado do celular manda
//   Ctrl+letra. 1 toque = so a proxima tecla; 2 toques = travado; 3o toque = desliga.
// - applyModifiers(): aplica Ctrl/Alt ao que o teclado do celular digitou (texto cru do xterm).
// - touchScroll(): converte o arrasto do dedo em "linhas" de rolagem (roda do mouse do tmux).

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

// kind: 'seq' manda a sequencia | 'mod' liga/desliga um modificador | 'action' (colar...)
// repeat: segurar o botao repete (setas)
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

// Atalhos do Claude Code (so nas sessoes de projeto)
export const CLAUDE_ACTIONS = [
  { id: 'esc', label: 'Esc', seq: SEQ.esc, title: 'Esc: stop Claude / cancel' },
  { id: 'mode', label: '⇧Tab mode', seq: SEQ.shiftTab, title: 'Shift+Tab: cycle mode (normal / auto-accept / plan)' },
  { id: 'a1', label: '1', seq: '1', title: 'Answer 1 (Yes)' },
  { id: 'a2', label: '2', seq: '2', title: 'Answer 2' },
  { id: 'a3', label: '3', seq: '3', title: 'Answer 3 (No)' },
  { id: 'enter', label: 'Enter', seq: SEQ.enter, title: 'Enter: confirm' },
  { id: 'rc', label: '/remote-control', seq: '/remote-control' + SEQ.enter, title: 'Type /remote-control + Enter' },
]

// ---------- modificadores grudentos ----------
// estado: 'off' -> 'once' (so a proxima tecla) -> 'lock' (ate desligar) -> 'off'
export function cycleMod(state) {
  return state === 'off' || !state ? 'once' : state === 'once' ? 'lock' : 'off'
}
// depois de usar: 'once' volta a 'off'; 'lock' continua
export const afterUse = (state) => (state === 'lock' ? 'lock' : 'off')

// Ctrl + 1 caractere -> byte de controle (ou null se nao existe Ctrl dessa tecla)
export function ctrlChar(ch) {
  if (!ch || ch.length !== 1) return null
  const c = ch.charCodeAt(0)
  if (c >= 97 && c <= 122) return String.fromCharCode(c - 96) // a-z
  if (c >= 65 && c <= 90) return String.fromCharCode(c - 64) // A-Z
  const map = { '@': '\x00', ' ': '\x00', '2': '\x00', '[': ESC, '3': ESC, '\\': '\x1c', '4': '\x1c', ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '7': '\x1f', '/': '\x1f', '?': '\x7f', '8': '\x7f' }
  return map[ch] ?? null
}

// CSI de cursor/edicao (setas, Home/End, PgUp/PgDn) com modificador xterm:
// ESC [ A -> ESC [ 1 ; m A   e   ESC [ 5 ~ -> ESC [ 5 ; m ~   (m = 1 + shift(1) + alt(2) + ctrl(4))
function modifyCsi(seq, m) {
  let r = /^\x1b\[([ABCDHF])$/.exec(seq) || /^\x1bO([ABCDHF])$/.exec(seq)
  if (r) return `${ESC}[1;${m}${r[1]}`
  r = /^\x1b\[(\d+)~$/.exec(seq)
  if (r) return `${ESC}[${r[1]};${m}~`
  return null
}

// Aplica Ctrl/Alt ao texto digitado. mods = { ctrl: bool, alt: bool }.
// So o PRIMEIRO "toque de tecla" e modificado (o resto de um texto colado/IME passa intacto).
export function applyModifiers(data, mods = {}) {
  if (!data || (!mods.ctrl && !mods.alt)) return data
  if (data.charCodeAt(0) === 27 && data.length > 1) {
    const m = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
    const csi = modifyCsi(data, m)
    if (csi) return csi
    return data // outra sequencia de escape: nao mexe
  }
  // 1o caractere (cuidado com surrogate pairs/emoji: nao tem Ctrl)
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
// fonte inicial: a salva pelo usuario, senao uma menor no celular (cabe ~45 colunas em 390px)
export const defaultFont = (narrow) => (narrow ? 12 : 13)

// ---------- rolagem por toque ----------
// dy = deslocamento do dedo (px, + = dedo desceu = rolar p/ CIMA no historico), cell = altura
// da linha (px), carry = sobra acumulada do arrasto anterior. Retorna { lines, carry }:
// lines > 0 = rolar p/ cima (historico), < 0 = p/ baixo.
export function touchScroll(dy, cell, carry = 0) {
  const h = cell > 0 ? cell : 16
  const total = carry + dy
  const lines = Math.trunc(total / h)
  return { lines, carry: total - lines * h }
}

// O xterm manda pelo onData tambem respostas AUTOMATICAS ao programa (relatorio de mouse, foco,
// posicao do cursor, atributos do terminal). Elas nao sao "a proxima tecla" do usuario: o Ctrl
// grudento nao pode ser aplicado nem gasto nelas.
export function isUserInput(data) {
  if (!data) return false
  return !/^\x1b\[(<[\d;]+[Mm]|M[\s\S]{3}|[IO]|\d+;\d+R|[?>][\d;]*c)$/.test(data)
}

// teclado virtual aberto? (altura visivel bem menor que a altura "cheia" da janela)
export const keyboardOpen = (visibleH, fullH) => fullH > 0 && visibleH > 0 && fullH - visibleH > 120
