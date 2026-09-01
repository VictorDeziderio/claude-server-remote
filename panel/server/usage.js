'use strict';
// Consumo de tokens + custo estimado: percorre ~/.claude/projects/**/*.jsonl uma vez (cache 10s)
// e agrega por dia, por (dia, projeto) e por modelo. O Claude guarda o historico em
// ~/.claude/projects/<cwd codificado> (nao-alfanumerico -> "-").
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

function rawByDay() {
  const base = path.join(cfg.CLAUDE_DIR, 'projects');
  const projByEnc = {};
  for (const name of listProjects()) projByEnc[encOf(path.join(cfg.PROJECTS_DIR, name))] = name;

  const perDay = {}; // 'YYYY-MM-DD' -> { ...bucket, byProject:{name:bucket}, byModel:{model:bucket} }
  let messages = 0;
  const files = [];
  (function walk(d, top) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, top || e.name);
      else if (e.name.endsWith('.jsonl')) files.push({ path: p, top: top || '' });
    }
  })(base, '');
  for (const f of files) {
    let data;
    try { if (fs.statSync(f.path).size > 64 * 1024 * 1024) continue; data = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    const pname = projByEnc[f.top] || null;
    for (const line of data.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const usg = o && o.message && o.message.usage;
      if (!usg) continue;
      const day = String(o.timestamp || '').slice(0, 10);
      if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
      messages++;
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
  return { perDay, sessions: files.length, messages };
}

let rawCache = { t: 0, v: null };
function rawCached() {
  const now = Date.now();
  if (rawCache.v && now - rawCache.t < 10000) return rawCache.v;
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
