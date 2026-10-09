'use strict';
// Alertas do ecossistema de scripts (claude-loop.sh, backup.sh, memory guard...): eles anexam
// linhas JSON em RUN_DIR/alerts.jsonl ({t, level, kind, project?, msg}). O servidor le so os
// bytes NOVOS (offset incremental), guarda os ultimos 100 em memoria e distribui por SSE.
// Lido pelo sampler de saude (health.js, 60s) — NUNCA no tick do watcher (2s): o arquivo e
// pequeno, mas nao ha motivo pra abrir/ler/parsear a cada 2s so por isso.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log } = require('./util');

const FILE = path.join(cfg.RUN_DIR, 'alerts.jsonl');
const MAX_KEEP = 100;
const LEVELS = new Set(['info', 'warn', 'error']);

let list = [];      // ultimos MAX_KEEP alertas (mais recente no fim)
let offset = 0;      // bytes do arquivo ja processados
let lastDiskAlertAt = 0;

const LABELS = { 'crash-loop': 'reinicios em loop', backup: 'backup', memory: 'memoria', disk: 'disco', 'claude-update': 'atualizacao do Claude' };
const titleFor = (a) => (LABELS[a.kind] || a.kind) + (a.project ? ` — ${a.project}` : '');

function pushAndBroadcast(a) {
  list.push(a);
  if (list.length > MAX_KEEP) list.splice(0, list.length - MAX_KEEP);
  // lazy (evita ciclo: events.js e' quem inicia o sampler que chama ate aqui)
  try {
    require('./events').broadcast('notify', { kind: 'alert', t: a.t, level: a.level, alertKind: a.kind, project: a.project || '', title: titleFor(a), body: a.msg || '' });
  } catch { /* */ }
}

// le as linhas NOVAS desde o ultimo offset. Se o arquivo encolheu (rotacao/truncamento pelos
// scripts) o offset e invalido -> reabre do zero.
function poll() {
  let st;
  try { st = fs.statSync(FILE); } catch { offset = 0; return; }
  if (st.size < offset) offset = 0;
  if (st.size === offset) return;
  let buf;
  try {
    const fd = fs.openSync(FILE, 'r');
    try { buf = Buffer.alloc(st.size - offset); fs.readSync(fd, buf, 0, buf.length, offset); }
    finally { fs.closeSync(fd); }
  } catch (e) { log('error', 'alerts poll', { err: e.message }); return; }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return; // ainda sem uma linha completa nova
  const text = buf.subarray(0, lastNl + 1).toString('utf8');
  offset += lastNl + 1;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let raw; try { raw = JSON.parse(line); } catch { continue; }
    if (!raw || typeof raw !== 'object' || !raw.kind) continue;
    pushAndBroadcast({
      t: typeof raw.t === 'number' ? raw.t : Date.now(),
      level: LEVELS.has(raw.level) ? raw.level : 'info',
      kind: String(raw.kind).slice(0, 40),
      project: raw.project ? String(raw.project).slice(0, 80) : '',
      msg: String(raw.msg || '').slice(0, 500),
    });
  }
}

// disco > 90%: no maximo 1x/hora, gravado no MESMO arquivo que poll() le (assim o fluxo de
// "chegou -> entra na lista -> SSE" e' um so, igual aos alertas vindos dos scripts).
function maybeDiskAlert(pct) {
  if (!(pct >= 90)) return;
  const now = Date.now();
  if (now - lastDiskAlertAt < 3600 * 1000) return;
  lastDiskAlertAt = now;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ t: now, level: 'warn', kind: 'disk', msg: `disco em ${pct}% de uso` }) + '\n');
  } catch (e) { log('error', 'disk alert', { err: e.message }); }
}

const list100 = () => list.slice();
const clear = () => { list = []; };

module.exports = { poll, maybeDiskAlert, list100, clear };
