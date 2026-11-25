'use strict';
const { tr } = require('./i18n');
// Logs do dev-box: tail dos arquivos em ~/.claude/logs (painel, backup, audit) — so leitura.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILES = {
  panel: { file: 'panel.log', label: 'Panel (server.js)' },
  backup: { file: 'backup.log', label: tr('srv.log.backup') },
  audit: { file: 'audit.log', label: 'Audit (who did what)' },
  sessions: { file: 'sessions.log', label: tr('srv.log.sessions') },
};

function listLogs() {
  return {
    ok: true,
    logs: Object.entries(FILES).map(([key, v]) => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(cfg.LOGS_DIR, v.file)); size = st.size; mtime = st.mtimeMs; } catch { /* ainda nao existe */ }
      return { key, label: v.label, file: v.file, size, mtime };
    }),
  };
}
// le so o FIM do arquivo (ate 512KB) e devolve as ultimas N linhas
function tailLog(key, lines) {
  const f = FILES[key];
  if (!f) return { ok: false, msg: tr('srv.unknownLog') };
  const n = Math.min(5000, Math.max(10, parseInt(lines, 10) || 300));
  const p = path.join(cfg.LOGS_DIR, f.file);
  let fd = null;
  try {
    const st = fs.statSync(p);
    const size = st.size;
    const want = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(want);
    fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, want, size - want);
    let text = buf.toString('utf8');
    if (want < size) text = text.slice(text.indexOf('\n') + 1); // descarta linha cortada
    const all = text.split('\n');
    if (all[all.length - 1] === '') all.pop();
    return { ok: true, key, label: f.label, lines: all.slice(-n), total: all.length, size, mtime: st.mtimeMs, truncated: want < size };
  } catch (e) {
    return e.code === 'ENOENT' ? { ok: true, key, label: f.label, lines: [], total: 0, size: 0, mtime: 0 } : { ok: false, msg: e.message };
  } finally { if (fd !== null) fs.closeSync(fd); }
}

module.exports = { listLogs, tailLog };
