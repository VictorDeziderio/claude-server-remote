'use strict';
// Audit log: quem fez o que, quando e de onde. JSON por linha em ~/.claude/logs/audit.log.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

let warned = false;
function audit(action, extra) {
  const line = JSON.stringify({ t: new Date().toISOString(), action, ...(extra || {}) }) + '\n';
  try {
    fs.mkdirSync(path.dirname(cfg.AUDIT_LOG), { recursive: true });
    fs.appendFileSync(cfg.AUDIT_LOG, line);
  } catch (e) {
    if (!warned) { warned = true; console.error('[audit] nao consegui gravar:', e.message); }
  }
}

// resumo seguro do corpo de uma acao (sem conteudo de arquivo/senhas)
function summarize(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const k of ['name', 'newName', 'key', 'value', 'path', 'newPath', 'kind', 'id', 'file', 'window']) {
    if (k in body) out[k] = typeof body[k] === 'string' ? body[k].slice(0, 200) : body[k];
  }
  if (typeof body.text === 'string') out.textLen = body.text.length;
  if (typeof body.content === 'string') out.contentLen = body.content.length;
  return out;
}

module.exports = { audit, summarize };
