#!/usr/bin/env node
// Unit tests of the front-end logic that runs without a browser (terminal keys on the phone,
// OSC 52). The src/ modules are pure ESM: loaded through a data: URL (independent of the package.json
// "type"). Usage: node test/unit.mjs  (npm test runs this + the smoke test)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const load = (rel) => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(PANEL, rel), 'utf8')).toString('base64'))
const K = await load('src/lib/termkeys.js')
const C = await load('src/lib/clipboard.js')
const T = await load('src/lib/theme.js')
const I = await load('src/lib/i18n-core.js')
const N = await load('src/lib/notice.js')
const CA = await load('src/chat/api.js')

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

console.log('\n== tema claro/escuro')
eq('sistema + aparelho escuro -> dark', T.resolveTheme('system', true), 'dark')
eq('sistema + aparelho claro -> light', T.resolveTheme('system', false), 'light')
eq('escolha fixa vence o aparelho', [T.resolveTheme('light', true), T.resolveTheme('dark', false)], ['light', 'dark'])
eq('valor estranho no localStorage -> sistema', T.resolveTheme('roxo', true), 'dark')
eq('ciclo sistema -> claro -> escuro -> sistema', [T.nextTheme('system'), T.nextTheme('light'), T.nextTheme('dark'), T.nextTheme(null)], ['light', 'dark', 'system', 'light'])
// the panel CSP (script-src 'self') blocks inline scripts: the initial theme comes from a file
const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8')
eq('index.html sem <script> inline (CSP)', [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/g)].length, 0)
eq('index.html carrega /theme-init.js antes do app', html.indexOf('/theme-init.js') > 0 && html.indexOf('/theme-init.js') < html.indexOf('/src/main.jsx'), true)
const init = fs.readFileSync(path.join(PANEL, 'public', 'theme-init.js'), 'utf8')
eq('theme-init usa a mesma chave do theme.js', init.includes("'" + T.THEME_KEY + "'"), true)

console.log('\n== chat: key from the URL and the SSE parser (src/chat/api.js)')
eq('key from /c/<key>', CA.keyFromPath('/c/AbC-_09xyz'), 'AbC-_09xyz')
eq('key from /c/<key>/ (trailing slash)', CA.keyFromPath('/c/AbC/'), 'AbC')
eq('no key outside /c/', CA.keyFromPath('/dashboard'), '')
{
  const got = []
  const rest = CA.parseSse('event: delta\ndata: {"text":"Hel"}\n\n: keep-alive\n\nevent: done\r\ndata: {"id":"s1"}\r\n\r\nevent: delta\ndata: {"te', (e, d) => got.push([e, d]))
  eq('SSE: events parsed in order, comments skipped, CRLF ok', got, [['delta', { text: 'Hel' }], ['done', { id: 's1' }]])
  eq('SSE: an incomplete event stays in the buffer', rest, 'event: delta\ndata: {"te')
  const more = []
  CA.parseSse(rest + 'xt":"lo"}\n\n', (e, d) => more.push([e, d]))
  eq('SSE: the rest completes with the next chunk', more, [['delta', { text: 'lo' }]])
}

console.log('\n== idiomas (src/locales/*.json)')
eq('idioma salvo vence', I.pickLang('pt-BR', ['en-US'], ['en', 'pt-BR'], 'en'), 'pt-BR')
eq('navegador pt-PT -> pt-BR (mesma base)', I.pickLang(null, ['pt-PT'], ['en', 'pt-BR'], 'en'), 'pt-BR')
eq('navegador em idioma sem arquivo -> padrao', I.pickLang(null, ['ja-JP'], ['en', 'pt-BR'], 'en'), 'en')
eq('salvo invalido -> navegador', I.pickLang('xx', ['pt-BR'], ['en', 'pt-BR'], 'en'), 'pt-BR')
eq('variaveis {n}', I.format('{n} linhas de {x}', { n: 3, x: 'a' }), '3 linhas de a')
eq('chave faltando no idioma cai no ingles', I.lookup({ en: { a: 'A' }, 'pt-BR': {} }, 'pt-BR', 'en', 'a'), 'A')
eq('chave faltando em tudo mostra a chave', I.lookup({ en: {} }, 'en', 'en', 'x.y'), 'x.y')
const LOC = path.join(PANEL, 'src', 'locales')
const locs = Object.fromEntries(fs.readdirSync(LOC).filter((f) => f.endsWith('.json')).map((f) => [f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(LOC, f), 'utf8'))]))
const enKeys = Object.keys(locs.en || {}).sort()
for (const [code, d] of Object.entries(locs)) {
  eq(`${code}.json tem _name`, typeof d._name === 'string' && d._name.length > 0, true)
  eq(`${code}.json tem as mesmas chaves do en.json`, JSON.stringify(Object.keys(d).sort().filter((k) => !enKeys.includes(k))) + JSON.stringify(enKeys.filter((k) => !(k in d))), '[][]')
  const badVars = enKeys.filter((k) => k in d && JSON.stringify((String(locs.en[k]).match(/\{\w+\}/g) || []).sort()) !== JSON.stringify((String(d[k]).match(/\{\w+\}/g) || []).sort()))
  eq(`${code}.json usa as mesmas {variaveis} do ingles`, badVars, [])
}
// every key used in the code (t('x'), tOr('x'), <TR k="x">) exists in en.json
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.jsx?$/.test(e.name) ? [path.join(d, e.name)] : []))
const used = new Set()
for (const f of walk(path.join(PANEL, 'src'))) {
  const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  for (const m of src.matchAll(/\b(?:t|tOr)\('([a-zA-Z][\w.-]*)'/g)) if (!m[1].endsWith('.')) used.add(m[1])
  for (const m of src.matchAll(/<TR k="([\w.-]+)"/g)) used.add(m[1])
  for (const m of src.matchAll(/'((?:smode|period|login\.(?:phase|screen|step))\.[\w-]+)'/g)) used.add(m[1])
}
// height in % only works if the parent has a height: the <div> right above a style={{ height: x + '%' }}
// needs an h-* class (otherwise the bar ends up 0px — the Report chart came out empty like that)
const pctNoParent = []
for (const f of walk(path.join(PANEL, 'src'))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  lines.forEach((l, i) => {
    if (!/style=\{\{[^}]*height:\s*[^}]*'%'/.test(l)) return
    let j = i - 1
    while (j >= 0 && !/<div\b/.test(lines[j])) j--
    if (j < 0 || !/className="[^"]*\bh-(full|\d+|\[)/.test(lines[j])) pctNoParent.push(path.basename(f) + ':' + (i + 1))
  })
}
eq('altura em % tem pai com altura (h-*)', pctNoParent, [])
// a component declared INSIDE another one (`  const Section = (...) => (<...>)`) is a new type on every
// render: React remounts it, inputs inside lose focus and the scroll jumps (the delete field of the
// "Configure" drawer). Components go at module level, data comes in props.
const innerComp = []
for (const f of walk(path.join(PANEL, 'src'))) {
  if (f.includes(path.join('components', 'ui') + path.sep)) continue
  fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (/^\s+const [A-Z]\w* = \([^)]*\) => \($/.test(l) || /^\s+function [A-Z]\w*\(/.test(l)) innerComp.push(path.basename(f) + ':' + (i + 1))
  })
}
eq('no component declared inside another component', innerComp, [])
eq('chaves usadas no codigo existem no en.json', [...used].filter((k) => !(k in (locs.en || {}))), [])

// server notices translated in the browser (lib/notice.js): key + vars, English as the fallback
{
  const pt = JSON.parse(fs.readFileSync(path.join(PANEL, 'src/locales/pt-BR.json'), 'utf8'))
  const tOrPt = (k, fb, v) => (k in pt ? I.format(pt[k], v || {}) : fb)
  eq('aviso: titulo/corpo pela chave no idioma de quem ve', N.noticeText({ kind: 'done', title: 'Claude finished — app', body: 'Worked for 7s and is now waiting.', i18n: { title: ['srv.doneTitle', { name: 'app' }], body: ['srv.doneBody', { s: 7 }] } }, tOrPt),
    { title: 'Claude terminou — app', body: 'Ficou 7s trabalhando e agora está aguardando.' })
  eq('aviso sem chave: usa o texto que veio', N.noticeText({ kind: 'done', title: 'X', body: 'Y' }, tOrPt), { title: 'X', body: 'Y' })
  eq('alerta: rotulo do tipo traduzido + projeto, corpo pela chave', N.noticeLine({ kind: 'alert', level: 'error', alertKind: 'crash-loop', project: 'demo', msg: 'Claude crashed 3 times', key: 'srv.alert.crashLoop', vars: { n: '3', rc: '1' } }, tOrPt),
    'reinícios em loop — demo — O Claude caiu 3 vezes seguidas (último código 1) — parei de reabrir. Veja Logs → Sessões.')
  eq('alerta (SSE) com alertKind', N.noticeText({ kind: 'alert', alertKind: 'disk', level: 'warn', msg: 'disk at 93% used', key: 'srv.diskFull', vars: { pct: 93 } }, tOrPt).body, 'disco em 93% de uso')
  eq('alerta de tipo desconhecido: mostra o tipo e a msg', N.noticeLine({ kind: 'alert', level: 'info', alertKind: 'custom', msg: 'hello' }, tOrPt), 'custom — hello')
}
console.log(`\n${passes} PASS, ${fails} FAIL${fails ? '' : ' — TUDO OK'}`)
process.exit(fails ? 1 : 0)
