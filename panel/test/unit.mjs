#!/usr/bin/env node
// Testes de unidade da logica do front que roda sem navegador (teclas do terminal no celular,
// OSC 52). Os modulos de src/ sao ESM puros: carregados por data: URL (independe do "type" do
// package.json). Uso: node test/unit.mjs  (o npm test roda este + o smoke)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(PANEL, rel), 'utf8')).toString('base64'))
const K = await load('src/lib/termkeys.js')
const C = await load('src/lib/clipboard.js')

let fails = 0, passes = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : `   -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`))
  ok ? passes++ : fails++
}
const E = '\x1b'

console.log('\n== termkeys: modificadores grudentos')
eq('cycleMod off -> once', K.cycleMod('off'), 'once')
eq('cycleMod once -> lock', K.cycleMod('once'), 'lock')
eq('cycleMod lock -> off', K.cycleMod('lock'), 'off')
eq('cycleMod undefined -> once', K.cycleMod(undefined), 'once')
eq('afterUse once -> off', K.afterUse('once'), 'off')
eq('afterUse lock -> lock', K.afterUse('lock'), 'lock')

console.log('\n== termkeys: Ctrl/Alt aplicados ao que o teclado do celular digitou')
eq('sem modificador: intacto', K.applyModifiers('abc', {}), 'abc')
eq('Ctrl+c = ^C', K.applyModifiers('c', { ctrl: true }), '\x03')
eq('Ctrl+C (maiuscula, teclado com shift) = ^C', K.applyModifiers('C', { ctrl: true }), '\x03')
eq('Ctrl+d = ^D', K.applyModifiers('d', { ctrl: true }), '\x04')
eq('Ctrl+[ = Esc', K.applyModifiers('[', { ctrl: true }), E)
eq('Ctrl+space = NUL', K.applyModifiers(' ', { ctrl: true }), '\x00')
eq('Ctrl+? = DEL', K.applyModifiers('?', { ctrl: true }), '\x7f')
eq('Ctrl so no 1o caractere (IME manda palavra)', K.applyModifiers('bc', { ctrl: true }), '\x02c')
eq('Ctrl+tecla sem Ctrl (emoji) passa intacta', K.applyModifiers('😀', { ctrl: true }), '😀')
eq('Alt+b = ESC b', K.applyModifiers('b', { alt: true }), E + 'b')
eq('Ctrl+Alt+a = ESC ^A', K.applyModifiers('a', { ctrl: true, alt: true }), E + '\x01')
eq('Ctrl+seta esquerda = CSI 1;5D', K.applyModifiers(E + '[D', { ctrl: true }), E + '[1;5D')
eq('Alt+seta direita = CSI 1;3C', K.applyModifiers(E + '[C', { alt: true }), E + '[1;3C')
eq('Ctrl+seta em modo aplicacao (ESC O A)', K.applyModifiers(E + 'OA', { ctrl: true }), E + '[1;5A')
eq('Ctrl+PgUp = CSI 5;5~', K.applyModifiers(E + '[5~', { ctrl: true }), E + '[5;5~')
eq('Ctrl+Home = CSI 1;5H', K.applyModifiers(E + '[H', { ctrl: true }), E + '[1;5H')
eq('outra sequencia de escape: intacta', K.applyModifiers(E + '[200~x', { ctrl: true }), E + '[200~x')
eq('Esc sozinho com Ctrl: intacto', K.applyModifiers(E, { ctrl: true }), E)

console.log('\n== termkeys: barras de teclas')
const ids = K.EXTRA_KEYS.map((k) => k.id)
for (const id of ['esc', 'tab', 'ctrl', 'alt', 'ctrlc', 'up', 'down', 'left', 'right', 'enter', 'slash', 'pipe', 'tilde', 'paste']) eq(`barra extra tem "${id}"`, ids.includes(id), true)
eq('ids da barra extra sao unicos', new Set(ids).size, ids.length)
eq('toda tecla tem seq, mod ou action', K.EXTRA_KEYS.every((k) => typeof k.seq === 'string' || k.mod || k.action), true)
eq('Ctrl+C da barra = \\x03', K.EXTRA_KEYS.find((k) => k.id === 'ctrlc').seq, '\x03')
const qa = Object.fromEntries(K.CLAUDE_ACTIONS.map((a) => [a.id, a.seq]))
eq('Claude: Shift+Tab = CSI Z (troca o modo)', qa.mode, E + '[Z')
eq('Claude: Esc', qa.esc, E)
eq('Claude: respostas 1/2/3 sem Enter', [qa.a1, qa.a2, qa.a3], ['1', '2', '3'])
eq('Claude: /remote-control + Enter', qa.rc, '/remote-control\r')

console.log('\n== termkeys: fonte e rolagem por toque')
eq('clampFont dentro', K.clampFont(14), 14)
eq('clampFont minimo', K.clampFont(2), K.FONT_MIN)
eq('clampFont maximo', K.clampFont(99), K.FONT_MAX)
eq('clampFont lixo -> default', K.clampFont('x'), 13)
eq('clampFont arredonda', K.clampFont(12.6), 13)
eq('defaultFont celular menor', K.defaultFont(true) < K.defaultFont(false), true)
eq('touchScroll: 50px / 16px = 3 linhas, sobra 2', K.touchScroll(50, 16, 0), { lines: 3, carry: 2 })
eq('touchScroll: sobra acumula', K.touchScroll(14, 16, 2), { lines: 1, carry: 0 })
eq('touchScroll: para baixo negativo', K.touchScroll(-40, 16, 0), { lines: -2, carry: -8 })
eq('touchScroll: pouco movimento = 0 linhas', K.touchScroll(5, 16, 0), { lines: 0, carry: 5 })
eq('touchScroll: celula invalida usa 16', K.touchScroll(32, 0, 0), { lines: 2, carry: 0 })

console.log('\n== termkeys: respostas automaticas do xterm nao gastam o Ctrl grudento')
eq('letra e input do usuario', K.isUserInput('a'), true)
eq('seta e input do usuario', K.isUserInput(E + '[A'), true)
eq('Esc e input do usuario', K.isUserInput(E), true)
eq('mouse SGR nao e', K.isUserInput(E + '[<0;10;5M'), false)
eq('mouse SGR soltar nao e', K.isUserInput(E + '[<0;10;5m'), false)
eq('mouse X10 nao e', K.isUserInput(E + '[M !!'), false)
eq('foco nao e', K.isUserInput(E + '[I'), false)
eq('posicao do cursor nao e', K.isUserInput(E + '[12;40R'), false)
eq('atributos do terminal nao e', K.isUserInput(E + '[?1;2c'), false)
eq('vazio nao e', K.isUserInput(''), false)
eq('teclado aberto (844 -> 500)', K.keyboardOpen(500, 844), true)
eq('teclado fechado (barra do navegador some: 844 -> 790)', K.keyboardOpen(790, 844), false)
eq('teclado: alturas invalidas', K.keyboardOpen(0, 0), false)

console.log('\n== clipboard: OSC 52')
eq('decodeOsc52 texto', C.decodeOsc52('c;' + Buffer.from('olá mundo').toString('base64')), 'olá mundo')
eq('decodeOsc52 pedido de leitura (?) ignorado', C.decodeOsc52('c;?'), null)
eq('decodeOsc52 sem ;', C.decodeOsc52('abc'), null)

console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`)
process.exit(fails ? 1 : 0)
