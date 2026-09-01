'use strict';
// Gerenciador de arquivos CONFINADO a FS_BASE (=/root): listar, stat, ler, salvar, criar,
// excluir, renomear, download e upload. resolveSafe rejeita qualquer caminho que escape
// da raiz (path traversal), inclusive via symlink resolvido.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const BASE = cfg.FS_BASE;
const MAX_TEXT = 2 * 1024 * 1024;     // leitura/edicao inline
const MAX_SAVE = 5 * 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;

function resolveSafe(rel) {
  const full = path.resolve(BASE, String(rel == null ? '' : rel).replace(/^[/\\]+/, ''));
  if (full !== BASE && !full.startsWith(BASE + path.sep)) return null;
  return full;
}
const relOf = (full) => path.relative(BASE, full).split(path.sep).join('/');

const TEXT_EXT = new Set(['.txt', '.md', '.json', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.css', '.html', '.sh', '.yml', '.yaml', '.toml', '.env', '.py', '.sql', '.xml', '.svg', '.csv', '.ini', '.conf', '.log', '.gitignore']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.html': 'text/html; charset=utf-8',
};

function statEntry(full, name) {
  try {
    const st = fs.statSync(full);
    return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : 0, mtime: st.mtimeMs };
  } catch { return { name, type: 'file', size: 0, mtime: 0, broken: true }; }
}

function fsStat(rel) {
  const full = resolveSafe(rel);
  if (!full) return { ok: false, msg: 'caminho invalido' };
  try {
    const st = fs.statSync(full);
    return { ok: true, path: relOf(full), type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
  } catch (e) { return { ok: false, msg: e.code === 'ENOENT' ? 'nao encontrado' : e.message, code: e.code }; }
}
function fsList(rel) {
  const full = resolveSafe(rel);
  if (!full) return { ok: false, msg: 'caminho invalido' };
  try {
    const entries = fs.readdirSync(full, { withFileTypes: true })
      .map((d) => statEntry(path.join(full, d.name), d.name))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, path: relOf(full), entries };
  } catch (e) { return { ok: false, msg: e.code === 'ENOTDIR' ? 'nao e uma pasta' : e.message, code: e.code }; }
}
function fsRead(rel) {
  const full = resolveSafe(rel);
  if (!full) return { ok: false, msg: 'caminho invalido' };
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return { ok: false, msg: 'nao e um arquivo' };
    if (st.size > MAX_TEXT) return { ok: false, msg: 'arquivo muito grande p/ editar aqui (>2MB) — use download', code: 'TOOBIG' };
    const buf = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    if (!TEXT_EXT.has(ext) && buf.subarray(0, 8000).includes(0)) return { ok: false, msg: 'arquivo binario (nao editavel aqui) — use download', code: 'BINARY' };
    return { ok: true, path: relOf(full), content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsSave(rel, content) {
  const full = resolveSafe(rel);
  if (!full || full === BASE) return { ok: false, msg: 'caminho invalido' };
  if (typeof content !== 'string') return { ok: false, msg: 'conteudo invalido' };
  if (content.length > MAX_SAVE) return { ok: false, msg: 'conteudo muito grande (>5MB)' };
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return { ok: true, msg: `salvo: ${relOf(full)}` };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsCreate(rel, kind) {
  const full = resolveSafe(rel);
  if (!full || full === BASE) return { ok: false, msg: 'caminho invalido' };
  if (fs.existsSync(full)) return { ok: false, msg: 'ja existe' };
  try {
    if (kind === 'dir') fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, ''); }
    return { ok: true, msg: `${kind === 'dir' ? 'pasta' : 'arquivo'} criado: ${relOf(full)}`, path: relOf(full) };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsDelete(rel) {
  const full = resolveSafe(rel);
  if (!full || full === BASE) return { ok: false, msg: 'caminho invalido' };
  // protege o coracao do volume (login do Claude, config do painel)
  if (full === path.join(BASE, '.claude') || full === path.join(BASE, '.claude.json')) return { ok: false, msg: 'protegido' };
  try { fs.rmSync(full, { recursive: true, force: true }); return { ok: true, msg: `excluido: ${relOf(full)}` }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
function fsRename(rel, newRel) {
  const a = resolveSafe(rel), b = resolveSafe(newRel);
  if (!a || !b || a === BASE || b === BASE) return { ok: false, msg: 'caminho invalido' };
  if (fs.existsSync(b)) return { ok: false, msg: 'o destino ja existe' };
  try { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); return { ok: true, msg: `renomeado: ${relOf(b)}`, path: relOf(b) }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
// download: stream do arquivo com Content-Disposition (qualquer tipo/tamanho)
function fsDownload(rel, res) {
  const full = resolveSafe(rel);
  let st;
  try { st = full && fs.statSync(full); } catch { /* */ }
  if (!full || !st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('arquivo nao encontrado');
  }
  const name = path.basename(full);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(full).pipe(res);
}
// upload: corpo bruto -> arquivo (ja lido pelo caller com readRaw)
function fsUpload(rel, buf, overwrite) {
  const full = resolveSafe(rel);
  if (!full || full === BASE) return { ok: false, msg: 'caminho invalido' };
  if (!buf) return { ok: false, msg: `upload muito grande (>${MAX_UPLOAD / 1024 / 1024}MB) ou interrompido` };
  if (!overwrite && fs.existsSync(full)) return { ok: false, msg: 'ja existe (marque sobrescrever)' };
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    return { ok: true, msg: `enviado: ${relOf(full)} (${buf.length} bytes)`, path: relOf(full) };
  } catch (e) { return { ok: false, msg: e.message }; }
}

module.exports = { fsStat, fsList, fsRead, fsSave, fsCreate, fsDelete, fsRename, fsDownload, fsUpload, MAX_UPLOAD };
