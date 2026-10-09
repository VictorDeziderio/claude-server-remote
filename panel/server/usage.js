'use strict';
// Consumo de tokens + custo estimado: percorre ~/.claude/projects/**/*.jsonl e agrega por dia,
// por (dia, projeto) e por modelo. O Claude guarda o historico em
// ~/.claude/projects/<cwd codificado> (nao-alfanumerico -> "-").
//
// Cache incremental por arquivo (achado @perf 2026-10-09): reler os .jsonl inteiros a cada
// poucos segundos travava o painel (~80% de 1 core, ~30s de CPU por passada em ~2GB/540
// arquivos) — o watcher de atividade (events.js, a cada 2s) chama buildState() -> aqui dentro
// a cada tick. .jsonl e append-only enquanto a sessao esta viva: arquivo que nao mudou de
// mtime+size nao e reaberto; arquivo que cresceu so le os bytes NOVOS (a partir do offset da
// ultima leitura) e soma por cima do que ja estava acumulado. Resultado e identico ao de ler
// tudo do zero (comparado com a versao anterior deste algoritmo via script de equivalencia
// contra um snapshot congelado de ~/.claude/projects) — so o custo que cai.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { listProjects } = require('./projects-list');

const encOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// Tabela de precos (US$ por 1M tokens) — API Anthropic, referencia 2026-06. Cache write 5min = 1.25x
// entrada; cache read = 0.1x (Fable 5.1 = $0.25). Match por substring do id do modelo; o que
// nao casar usa "default" e e marcado como estimativa grosseira. Nao substitui a fatura real.
const PRICES = [
  ['fable-5-1', { in: 10, out: 50, cw: 12.5, cr: 0.25 }],
  ['mythos-5-1', { in: 10, out: 50, cw: 12.5, cr: 0.25 }],
  ['fable-5', { in: 10, out: 50, cw: 12.5, cr: 1.0 }],
  ['mythos', { in: 10, out: 50, cw: 12.5, cr: 1.0 }],
  ['opus-5', { in: 5, out: 25, cw: 6.25, cr: 0.5 }],
  ['opus-4-8', { in: 5, out: 25, cw: 6.25, cr: 0.5 }],
  ['opus-4-7', { in: 5, out: 25, cw: 6.25, cr: 0.5 }],
  ['opus-4-6', { in: 5, out: 25, cw: 6.25, cr: 0.5 }],
  ['opus-4-5', { in: 5, out: 25, cw: 6.25, cr: 0.5 }],
  ['opus-4', { in: 15, out: 75, cw: 18.75, cr: 1.5 }],
  ['sonnet-5', { in: 2, out: 10, cw: 2.5, cr: 0.2 }],
  ['sonnet-4-6', { in: 3, out: 15, cw: 3.75, cr: 0.3 }],
  ['sonnet-4', { in: 3, out: 15, cw: 3.75, cr: 0.3 }],
  ['sonnet-3', { in: 3, out: 15, cw: 3.75, cr: 0.3 }],
  ['haiku-4-5', { in: 1, out: 5, cw: 1.25, cr: 0.1 }],
  ['haiku-3-5', { in: 0.8, out: 4, cw: 1, cr: 0.08 }],
  ['haiku', { in: 1, out: 5, cw: 1.25, cr: 0.1 }],
];
const DEFAULT_PRICE = { in: 5, out: 25, cw: 6.25, cr: 0.5 };
const priceCache = {};
function priceOf(model) {
  const m = String(model || '').toLowerCase();
  if (priceCache[m]) return priceCache[m];
  const hit = PRICES.find(([k]) => m.includes(k));
  return (priceCache[m] = hit ? { ...hit[1], known: true } : { ...DEFAULT_PRICE, known: false });
}
const costOf = (b, model) => {
  const p = priceOf(model);
  return (b.in * p.in + b.out * p.out + b.cacheW * p.cw + b.cacheR * p.cr) / 1e6;
};

const bucket = () => ({ in: 0, out: 0, cacheW: 0, cacheR: 0, messages: 0, cost: 0 });
const add = (t, b) => { t.in += b.in; t.out += b.out; t.cacheW += b.cacheW; t.cacheR += b.cacheR; t.messages += b.messages; t.cost += b.cost; };
// soma um "dia" (bucket + byProject + byModel) de `source` dentro de `target`, dia a dia
function mergeDayInto(target, source) {
  for (const [day, srcD] of Object.entries(source)) {
    const D = target[day] || (target[day] = { ...bucket(), byProject: {}, byModel: {} });
    add(D, srcD);
    for (const [name, b] of Object.entries(srcD.byProject)) add(D.byProject[name] || (D.byProject[name] = bucket()), b);
    for (const [model, b] of Object.entries(srcD.byModel)) add(D.byModel[model] || (D.byModel[model] = bucket()), b);
  }
}

// parseia um trecho de texto (linhas .jsonl completas) e acumula em `perDay` + `stats.messages`
function parseLinesInto(text, pname, perDay, stats) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const usg = o && o.message && o.message.usage;
    if (!usg) continue;
    const day = String(o.timestamp || '').slice(0, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
    stats.messages++;
    const model = (o.message && o.message.model) || 'desconhecido';
    const b = {
      in: usg.input_tokens || 0, out: usg.output_tokens || 0,
      cacheW: usg.cache_creation_input_tokens || 0, cacheR: usg.cache_read_input_tokens || 0, messages: 1, cost: 0,
    };
    b.cost = costOf(b, model);
    const D = perDay[day] || (perDay[day] = { ...bucket(), byProject: {}, byModel: {} });
    add(D, b);
    if (pname) add(D.byProject[pname] || (D.byProject[pname] = bucket()), b);
    add(D.byModel[model] || (D.byModel[model] = bucket()), b);
  }
}

// path absoluto -> { mtimeMs, size, offset (bytes ja lidos), pname, perDay (acumulado deste arquivo), messages }
const fileState = new Map();

// atualiza (ou cria) o estado incremental de UM arquivo e devolve a entrada (com `perDay` SO
// deste arquivo) — null se o arquivo sumiu, deu erro de leitura, ou passa de 64MB (mesmo limite
// de antes: fica de fora da agregacao, mesmo que ja tivesse entrado antes de crescer).
function fileContribution(fpath, pname) {
  let st;
  try { st = fs.statSync(fpath); } catch { fileState.delete(fpath); return null; }
  if (st.size > 64 * 1024 * 1024) { fileState.delete(fpath); return null; }
  const prev = fileState.get(fpath);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev; // nada mudou
  const fromScratch = !prev || st.size < prev.size; // novo, ou truncado/girado (nao deveria acontecer com .jsonl, mas nao confia)
  const start = fromScratch ? 0 : prev.offset;
  let buf;
  try {
    const fd = fs.openSync(fpath, 'r');
    try { buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); }
    finally { fs.closeSync(fd); }
  } catch { fileState.delete(fpath); return null; }
  // acha o ultimo '\n' em BYTES (0x0a e sempre 1 byte, nunca parte de um char multibyte UTF-8).
  // usar text.lastIndexOf('\n') numa string decodificada seria um bug: String.length conta
  // unidades UTF-16, nao bytes — qualquer acento/emoji no conteudo desalinha o offset (achado
  // @perf 2026-10-09: foi exatamente isso que causava contagem duplicada entre leituras —
  // o proximo read reabria um trecho que ja tinha sido contado).
  const lastNlByte = buf.lastIndexOf(0x0a);
  const completeBuf = lastNlByte === -1 ? Buffer.alloc(0) : buf.subarray(0, lastNlByte + 1);
  const complete = completeBuf.toString('utf8'); // so linhas completas (um append pode estar na metade)
  const perDay = fromScratch ? {} : prev.perDay; // estende o mesmo acumulado (nada le o objeto antigo depois disso)
  const stats = { messages: 0 };
  parseLinesInto(complete, pname, perDay, stats);
  const entry = {
    mtimeMs: st.mtimeMs, size: start + completeBuf.length, offset: start + completeBuf.length, pname,
    perDay, messages: (fromScratch ? 0 : prev.messages) + stats.messages,
  };
  fileState.set(fpath, entry);
  return entry;
}

function rawByDay() {
  const base = path.join(cfg.CLAUDE_DIR, 'projects');
  const projByEnc = {};
  for (const name of listProjects()) projByEnc[encOf(path.join(cfg.PROJECTS_DIR, name))] = name;

  const files = [];
  (function walk(d, top) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, top || e.name);
      else if (e.name.endsWith('.jsonl')) files.push({ path: p, top: top || '' });
    }
  })(base, '');

  const perDay = {};
  let messages = 0;
  const seen = new Set();
  for (const f of files) {
    seen.add(f.path);
    const pname = projByEnc[f.top] || null;
    const entry = fileContribution(f.path, pname);
    if (!entry) continue;
    mergeDayInto(perDay, entry.perDay);
    messages += entry.messages;
  }
  // limpa o cache de arquivos que sairam do disco (nao cresce pra sempre)
  for (const k of fileState.keys()) if (!seen.has(k)) fileState.delete(k);
  return { perDay, sessions: files.length, messages };
}

// subiu de 10s pra 60s (achado @perf 2026-10-09): com o cache incremental acima a passada
// completa ja e barata (so stat() de cada arquivo + merge em memoria), mas nao ha necessidade
// de refazer isso a cada tick do watcher (2s) — o dashboard nao precisa de uso/custo com
// granularidade menor que ~1min.
let rawCache = { t: 0, v: null };
function rawCached() {
  const now = Date.now();
  if (rawCache.v && now - rawCache.t < 60000) return rawCache.v;
  rawCache = { t: now, v: rawByDay() };
  return rawCache.v;
}

// agrega o periodo [from, to] (inclusivo, 'YYYY-MM-DD'; vazio = sem limite)
function aggregateRange(from, to) {
  const raw = rawCached();
  const out = {
    from: from || '', to: to || '', sessions: raw.sessions, messages: 0,
    total: bucket(), byProject: {}, byModel: {}, dailyArr: [],
    unknownModels: [],
  };
  for (const day of Object.keys(raw.perDay).sort()) {
    if (from && day < from) continue;
    if (to && day > to) continue;
    const D = raw.perDay[day];
    add(out.total, D);
    out.messages += D.messages;
    out.dailyArr.push({ date: day, in: D.in, out: D.out, cacheW: D.cacheW, cacheR: D.cacheR, cost: D.cost, messages: D.messages });
    for (const [name, b] of Object.entries(D.byProject)) add(out.byProject[name] || (out.byProject[name] = bucket()), b);
    for (const [model, b] of Object.entries(D.byModel)) {
      add(out.byModel[model] || (out.byModel[model] = { ...bucket(), known: priceOf(model).known }), b);
    }
  }
  out.unknownModels = Object.entries(out.byModel).filter(([, b]) => !b.known).map(([m]) => m);
  return out;
}

// usage do dashboard: total (tudo) + hoje + ultimos 30 dias
function usageSummary() {
  const all = aggregateRange('', '');
  const today = new Date().toISOString().slice(0, 10);
  all.today = aggregateRange(today, today).total;
  all.dailyArr = all.dailyArr.slice(-30);
  return all;
}

const isDay = (s) => !s || /^\d{4}-\d\d-\d\d$/.test(s);

module.exports = { aggregateRange, usageSummary, isDay, priceOf };
