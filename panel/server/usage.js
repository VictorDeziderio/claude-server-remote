'use strict';
// Consumo de tokens: percorre ~/.claude/projects/**/*.jsonl uma vez (cache 10s) e agrega
// por dia e por (dia, projeto). O Claude guarda o historico em ~/.claude/projects/<cwd
// codificado> (nao-alfanumerico -> "-").
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { listProjects } = require('./projects-list');

const encOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function rawByDay() {
  const base = path.join(cfg.HOME, '.claude', 'projects');
  const projByEnc = {};
  for (const name of listProjects()) projByEnc[encOf(path.join(cfg.PROJECTS_DIR, name))] = name;

  const perDay = {}; // 'YYYY-MM-DD' -> {in,out,cacheW,cacheR,messages, byProject:{name:{...}}}
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
      const iTok = usg.input_tokens || 0, oTok = usg.output_tokens || 0;
      const cw = usg.cache_creation_input_tokens || 0, cr = usg.cache_read_input_tokens || 0;
      const D = perDay[day] || (perDay[day] = { in: 0, out: 0, cacheW: 0, cacheR: 0, messages: 0, byProject: {} });
      D.in += iTok; D.out += oTok; D.cacheW += cw; D.cacheR += cr; D.messages++;
      if (pname) {
        const b = D.byProject[pname] || (D.byProject[pname] = { in: 0, out: 0, cacheW: 0, cacheR: 0, messages: 0 });
        b.in += iTok; b.out += oTok; b.cacheW += cw; b.cacheR += cr; b.messages++;
      }
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
    total: { in: 0, out: 0, cacheW: 0, cacheR: 0 },
    byProject: {}, dailyArr: [],
  };
  for (const day of Object.keys(raw.perDay).sort()) {
    if (from && day < from) continue;
    if (to && day > to) continue;
    const D = raw.perDay[day];
    out.total.in += D.in; out.total.out += D.out; out.total.cacheW += D.cacheW; out.total.cacheR += D.cacheR;
    out.messages += D.messages;
    out.dailyArr.push({ date: day, in: D.in, out: D.out });
    for (const [name, b] of Object.entries(D.byProject)) {
      const t = out.byProject[name] || (out.byProject[name] = { in: 0, out: 0, cacheW: 0, cacheR: 0, messages: 0 });
      t.in += b.in; t.out += b.out; t.cacheW += b.cacheW; t.cacheR += b.cacheR; t.messages += b.messages;
    }
  }
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

module.exports = { aggregateRange, usageSummary, isDay };
