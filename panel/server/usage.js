'use strict';
// Token use + estimated cost: walks ~/.claude/projects/**/*.jsonl and aggregates per day,
// per (day, project) and per model. Claude keeps the history in
// ~/.claude/projects/<encoded cwd> (non-alphanumeric -> "-").
//
// Incremental per-file cache (found by @perf 2026-10-09): rereading the whole .jsonl files every
// few seconds froze the panel (~80% of 1 core, ~30s of CPU per pass over ~2GB/540
// files) — the activity watcher (events.js, every 2s) calls buildState() -> in here
// on each tick. .jsonl is append-only while the session is alive: a file whose
// mtime+size did not change is not reopened; a file that grew only reads the NEW bytes (from the offset of the
// last read) and adds them on top of what was already accumulated. The result is identical to reading
// everything from scratch (compared with the previous version of this algorithm via an equivalence script
// against a frozen snapshot of ~/.claude/projects) — only the cost goes down.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { listProjects } = require('./projects-list');

const encOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// Price table (US$ per 1M tokens) — Anthropic API, reference 2026-06. Cache write 5min = 1.25x
// input; cache read = 0.1x (Fable 5.1 = $0.25). Matched by substring of the model id; whatever
// does not match uses "default" and is marked as a rough estimate. Does not replace the real invoice.
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
// adds a "day" (bucket + byProject + byModel) of `source` into `target`, day by day
function mergeDayInto(target, source) {
  for (const [day, srcD] of Object.entries(source)) {
    const D = target[day] || (target[day] = { ...bucket(), byProject: {}, byModel: {} });
    add(D, srcD);
    for (const [name, b] of Object.entries(srcD.byProject)) add(D.byProject[name] || (D.byProject[name] = bucket()), b);
    for (const [model, b] of Object.entries(srcD.byModel)) add(D.byModel[model] || (D.byModel[model] = bucket()), b);
  }
}

// parses a chunk of text (complete .jsonl lines) and accumulates into `perDay` + `stats.messages`
function parseLinesInto(text, pname, perDay, stats) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const usg = o && o.message && o.message.usage;
    if (!usg) continue;
    const day = String(o.timestamp || '').slice(0, 10);
    if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
    stats.messages++;
    const model = (o.message && o.message.model) || 'unknown';
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

// absolute path -> { mtimeMs, size, offset (bytes already read), pname, perDay (accumulated for this file), messages }
const fileState = new Map();

// updates (or creates) the incremental state of ONE file and returns the entry (with `perDay` ONLY
// for this file) — null if the file is gone, failed to read, or is over 64MB (same limit
// as before: it stays out of the aggregation, even if it was already in before growing).
function fileContribution(fpath, pname) {
  let st;
  try { st = fs.statSync(fpath); } catch { fileState.delete(fpath); return null; }
  if (st.size > 64 * 1024 * 1024) { fileState.delete(fpath); return null; }
  const prev = fileState.get(fpath);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return prev; // nothing changed
  const fromScratch = !prev || st.size < prev.size; // new, or truncated/rotated (should not happen with .jsonl, but do not trust it)
  const start = fromScratch ? 0 : prev.offset;
  let buf;
  try {
    const fd = fs.openSync(fpath, 'r');
    try { buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); }
    finally { fs.closeSync(fd); }
  } catch { fileState.delete(fpath); return null; }
  // finds the last '\n' in BYTES (0x0a is always 1 byte, never part of a multibyte UTF-8 char).
  // using text.lastIndexOf('\n') on a decoded string would be a bug: String.length counts
  // UTF-16 units, not bytes — any accent/emoji in the content misaligns the offset (found by
  // @perf 2026-10-09: that is exactly what caused double counting between reads —
  // the next read reopened a chunk that had already been counted).
  const lastNlByte = buf.lastIndexOf(0x0a);
  const completeBuf = lastNlByte === -1 ? Buffer.alloc(0) : buf.subarray(0, lastNlByte + 1);
  const complete = completeBuf.toString('utf8'); // only complete lines (an append may be halfway)
  const perDay = fromScratch ? {} : prev.perDay; // extends the same accumulator (nothing reads the old object after this)
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
  // drops the cache of files that left the disk (does not grow forever)
  for (const k of fileState.keys()) if (!seen.has(k)) fileState.delete(k);
  return { perDay, sessions: files.length, messages };
}

// raised from 10s to 60s (found by @perf 2026-10-09): with the incremental cache above the full
// pass is already cheap (only a stat() of each file + an in-memory merge), but there is no need
// to redo it on every watcher tick (2s) — the dashboard does not need usage/cost with
// a granularity finer than ~1min.
let rawCache = { t: 0, v: null };
function rawCached() {
  const now = Date.now();
  if (rawCache.v && now - rawCache.t < 60000) return rawCache.v;
  rawCache = { t: now, v: rawByDay() };
  return rawCache.v;
}

// aggregates the period [from, to] (inclusive, 'YYYY-MM-DD'; empty = no limit)
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

// dashboard usage: total (everything) + today + last 30 days
function usageSummary() {
  const all = aggregateRange('', '');
  const today = new Date().toISOString().slice(0, 10);
  all.today = aggregateRange(today, today).total;
  all.dailyArr = all.dailyArr.slice(-30);
  return all;
}

const isDay = (s) => !s || /^\d{4}-\d\d-\d\d$/.test(s);

module.exports = { aggregateRange, usageSummary, isDay, priceOf };
