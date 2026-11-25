'use strict';
const { tr } = require('./i18n');
// Gerenciador de arquivos CONFINADO a FS_BASE (=/root): listar, stat, ler, salvar, criar,
// excluir, renomear, download e upload.
//
// Confinamento (guard): duas checagens, nesta ordem.
//  1. TEXTUAL: o caminho pedido, normalizado (path.resolve), tem de ficar dentro da base
//     -> barra "../..", "/etc", "..\\..".
//  2. REAL (symlinks): o caminho e resolvido com realpath — o do proprio alvo quando ele
//     existe; o do ancestral existente mais proximo quando ainda vai ser criado — e o
//     resultado tem de ficar dentro do realpath da base.
//     - symlink que aponta para DENTRO da base: permitido (e so um atalho);
//     - symlink que aponta para FORA: recusado, com a mensagem dizendo o motivo;
//     - excluir/renomear o PROPRIO link: permitido (age no link, nunca no alvo) — assim da
//       para remover um link perigoso pelo painel. Para isso checa-se o diretorio-pai.
//  Na listagem, um link para fora aparece marcado (outside:true) sem stat do alvo.
//  Risco aceito: entre a checagem e o uso (TOCTOU) outro processo pode trocar um caminho
//  por um symlink. Quem tem acesso ao painel ja tem um shell no servidor; a sandbox protege
//  contra engano/clique errado no gerenciador, nao contra o proprio usuario do shell.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const BASE = cfg.FS_BASE;
const MAX_TEXT = 2 * 1024 * 1024;     // leitura/edicao inline
const MAX_SAVE = 5 * 1024 * 1024;
const MAX_UPLOAD = 100 * 1024 * 1024;

let baseReal = null;
const realBase = () => {
  if (!baseReal) { try { baseReal = fs.realpathSync(BASE); } catch { baseReal = BASE; } }
  return baseReal;
};
const inside = (p, base) => p === base || p.startsWith(base + path.sep);
const OUTSIDE_MSG = 'recusado: esse caminho passa por um symlink que aponta para fora de ' + BASE;

// realpath de `full`; se ele (ou parte do fim) ainda nao existe, realpath do ancestral
// existente mais proximo + o resto do caminho
function realOf(full) {
  let cur = full;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return full;
      rest.push(path.basename(cur)); cur = parent;
    }
  }
}

// -> { full } | { err }.  self=true: a operacao age no PROPRIO caminho (excluir/renomear),
// entao um symlink no fim do caminho e aceito e so o diretorio-pai precisa ser real-dentro.
function guard(rel, { self = false } = {}) {
  const full = path.resolve(BASE, String(rel == null ? '' : rel).replace(/^[/\\]+/, ''));
  if (!inside(full, BASE)) return { err: tr('srv.badPath') };
  let real;
  try {
    if (self && full !== BASE) {
      real = path.join(realOf(path.dirname(full)), path.basename(full));
    } else {
      // achado @security: se `full` e um symlink QUEBRADO (aponta p/ algo que nao existe),
      // fs.realpathSync(full) da ENOENT e o realOf() caia no fallback de "ainda nao existe,
      // sobe pro ancestral mais proximo" — tratando o PROPRIO link como se fosse so um nome
      // de arquivo novo, nunca resolvendo pra onde ele apontava. O resultado "real" sai de
      // dentro da base (o diretorio que contem o link e' real), guard() libera, e o
      // writeFileSync/openSync que vem depois SEGUE o link de verdade -> escreve fora da
      // sandbox. Symlink no fim do caminho tem de ser resolvido por completo aqui; se nao
      // resolver (quebrado), recusa — nunca trata como "arquivo novo".
      let lst;
      try { lst = fs.lstatSync(full); } catch { lst = null; }
      if (lst && lst.isSymbolicLink()) {
        try { real = fs.realpathSync(full); }
        catch { return { err: tr('srv.brokenLink') }; }
      } else {
        real = realOf(full);
      }
    }
  } catch (e) { return { err: e.message }; }
  if (!inside(real, realBase())) return { err: OUTSIDE_MSG };
  return { full };
}
// escreve um arquivo NOVO/truncado recusando seguir um symlink no ultimo componente (O_NOFOLLOW):
// defesa em profundidade contra TOCTOU entre o guard() acima e a escrita real.
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0; // indisponivel no Windows -> degrada sem o reforco
function writeFileNoFollow(full, data) {
  const fd = fs.openSync(full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NOFOLLOW);
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
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
    if (fs.lstatSync(full).isSymbolicLink() && !inside(realOf(full), realBase())) {
      return { name, type: 'file', size: 0, mtime: 0, link: true, outside: true }; // sem stat do alvo
    }
    const st = fs.statSync(full);
    return { name, type: st.isDirectory() ? 'dir' : 'file', size: st.isFile() ? st.size : 0, mtime: st.mtimeMs };
  } catch { return { name, type: 'file', size: 0, mtime: 0, broken: true }; }
}

function fsStat(rel) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  try {
    const st = fs.statSync(full);
    return { ok: true, path: relOf(full), type: st.isDirectory() ? 'dir' : 'file', size: st.size, mtime: st.mtimeMs };
  } catch (e) { return { ok: false, msg: e.code === 'ENOENT' ? tr('srv.notFound') : e.message, code: e.code }; }
}
function fsList(rel) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  try {
    const entries = fs.readdirSync(full, { withFileTypes: true })
      .map((d) => statEntry(path.join(full, d.name), d.name))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, path: relOf(full), entries };
  } catch (e) { return { ok: false, msg: e.code === 'ENOTDIR' ? tr('srv.notADir') : e.message, code: e.code }; }
}
function fsRead(rel) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return { ok: false, msg: tr('srv.notAFile') };
    if (st.size > MAX_TEXT) return { ok: false, msg: tr('srv.tooBig'), code: 'TOOBIG' };
    const buf = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    if (!TEXT_EXT.has(ext) && buf.subarray(0, 8000).includes(0)) return { ok: false, msg: tr('srv.binary'), code: 'BINARY' };
    return { ok: true, path: relOf(full), content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsSave(rel, content) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  if (full === BASE) return { ok: false, msg: tr('srv.badPath') };
  if (typeof content !== 'string') return { ok: false, msg: tr('srv.badContent') };
  if (content.length > MAX_SAVE) return { ok: false, msg: tr('srv.contentTooBig') };
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    writeFileNoFollow(full, content);
    return { ok: true, msg: tr('srv.saved', { path: relOf(full) }) };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsCreate(rel, kind) {
  const { full, err } = guard(rel);
  if (err) return { ok: false, msg: err };
  if (full === BASE) return { ok: false, msg: tr('srv.badPath') };
  if (fs.existsSync(full)) return { ok: false, msg: tr('srv.exists') };
  try {
    if (kind === 'dir') fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); writeFileNoFollow(full, ''); }
    return { ok: true, msg: tr(kind === 'dir' ? 'srv.dirCreated' : 'srv.fileCreated', { path: relOf(full) }), path: relOf(full) };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function fsDelete(rel) {
  const { full, err } = guard(rel, { self: true }); // apagar um link remove o LINK, nunca o alvo
  if (err) return { ok: false, msg: err };
  if (full === BASE) return { ok: false, msg: tr('srv.badPath') };
  // protege o coracao do volume (login do Claude, config do painel)
  if (full === path.join(BASE, '.claude') || full === path.join(BASE, '.claude.json')) return { ok: false, msg: tr('srv.protected') };
  try { fs.rmSync(full, { recursive: true, force: true }); return { ok: true, msg: tr('srv.removed', { path: relOf(full) }) }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
function fsRename(rel, newRel) {
  const ga = guard(rel, { self: true }), gb = guard(newRel);
  if (ga.err || gb.err) return { ok: false, msg: ga.err || gb.err };
  const a = ga.full, b = gb.full;
  if (a === BASE || b === BASE) return { ok: false, msg: tr('srv.badPath') };
  if (fs.existsSync(b)) return { ok: false, msg: tr('srv.destExists') };
  try { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); return { ok: true, msg: tr('srv.renamed', { path: relOf(b) }), path: relOf(b) }; }
  catch (e) { return { ok: false, msg: e.message }; }
}
// download: stream do arquivo com Content-Disposition (qualquer tipo/tamanho)
function fsDownload(rel, res) {
  const { full, err } = guard(rel);
  if (err) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(err); }
  let st;
  try { st = fs.statSync(full); } catch { /* */ }
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(tr('srv.fileNotFound'));
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
// upload: ESTREAMADO direto pro disco (achado @security: um Buffer por upload, ate 100MB,
// sem limite de quantos em paralelo, deixava a RAM do painel proporcional a uploads simultaneos).
// Escreve num temp na MESMA pasta (rename e atomico) e so troca pro nome final no final; se
// passar do limite so para de GRAVAR (sem acumular em memoria) e deixa o corpo dre nar sozinho
// ate o 'end' natural — do mesmo jeito que o readRaw (nao pode destruir o socket e perder a
// resposta). Cap de uploads simultaneos: protege contra varios uploads grandes ao mesmo tempo
// saturando disco/CPU (hash/gzip de proxy, etc.).
const MAX_CONCURRENT_UPLOADS = 2;
let activeUploads = 0;
function fsUploadStream(rel, req, overwrite) {
  const { full, err } = guard(rel);
  if (err) return Promise.resolve({ ok: false, msg: err });
  if (full === BASE) return Promise.resolve({ ok: false, msg: tr('srv.badPath') });
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return Promise.resolve({ ok: false, status: 429, msg: tr('srv.tooManyUploads') });
  }
  activeUploads++;
  const tmp = full + '.upload-' + crypto.randomBytes(8).toString('hex') + '.tmp';
  return new Promise((resolve) => {
    let size = 0, over = false, writeErr = null, fd = null, done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* */ } }
      activeUploads--;
      if (!v.ok) { try { fs.rmSync(tmp, { force: true }); } catch { /* */ } }
      resolve(v);
    };
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW);
    } catch (e) { return finish({ ok: false, msg: e.message }); }
    req.on('data', (chunk) => {
      if (over || writeErr) return;
      size += chunk.length;
      if (size > MAX_UPLOAD) { over = true; return; } // para de gravar, mas deixa o corpo drenar
      try { fs.writeSync(fd, chunk); } catch (e) { writeErr = e; }
    });
    req.on('end', () => {
      if (writeErr) return finish({ ok: false, msg: writeErr.message });
      if (over) return finish({ ok: false, msg: tr('srv.uploadTooBig', { mb: MAX_UPLOAD / 1024 / 1024 }) });
      if (!overwrite && fs.existsSync(full)) return finish({ ok: false, code: 'EXISTS', msg: tr('srv.existsOverwrite') });
      try { fs.closeSync(fd); fd = null; fs.renameSync(tmp, full); }
      catch (e) { return finish({ ok: false, msg: e.message }); }
      finish({ ok: true, msg: tr('srv.uploaded', { path: relOf(full), size }), path: relOf(full), size });
    });
    req.on('error', () => finish({ ok: false, msg: tr('srv.uploadBroken') }));
    req.on('close', () => finish({ ok: false, msg: tr('srv.uploadBroken') }));
  });
}

module.exports = { fsStat, fsList, fsRead, fsSave, fsCreate, fsDelete, fsRename, fsDownload, fsUploadStream, MAX_UPLOAD };
