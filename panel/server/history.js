'use strict';
const { tr } = require('./i18n');
// Historico de conversas do Claude por projeto (lendo ~/.claude/projects/<cwd codificado>/*.jsonl)
// + "continuar" uma conversa (claude --resume <id>) via flag lida pelo claude-loop.sh.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const cfg = require('./config');
const { sh, validName, sessionName, paneOf } = require('./util');

const encOf = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const dirOf = (name) => path.join(cfg.CLAUDE_DIR, 'projects', encOf(path.join(cfg.PROJECTS_DIR, name)));

// extrai texto de um message.content (string ou array de blocos)
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    if (!b) return '';
    if (b.type === 'text') return b.text || '';
    if (b.type === 'tool_use') return `[ferramenta: ${b.name || '?'}]`;
    if (b.type === 'tool_result') return typeof b.content === 'string' ? `[resultado] ${b.content}` : '[resultado]';
    if (b.type === 'thinking') return '';
    return '';
  }).filter(Boolean).join('\n');
}

// le um .jsonl e devolve resumo {id, title, first, last, messages, model, tokens}
// achado @security: readFileSync (ate 64MB) travava o event loop por arquivo; assincrono
// (fs/promises) deixa a leitura em disco fora do loop — so o parse das linhas continua sincrono.
async function summarizeFile(file, wantMessages) {
  let data;
  try { if ((await fsp.stat(file)).size > 64 * 1024 * 1024) return null; data = await fsp.readFile(file, 'utf8'); } catch { return null; }
  const id = path.basename(file, '.jsonl');
  let title = '', first = '', last = '', model = '', count = 0;
  let tokens = 0;
  const msgs = [];
  for (const line of data.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o && o.message;
    if (!m || !m.role) continue;
    const ts = String(o.timestamp || '');
    if (!first) first = ts;
    last = ts;
    const text = textOf(m.content);
    if (m.role === 'user' && !title && text && !text.startsWith('[') && !/^<[a-z-]+>/.test(text)) title = text.slice(0, 120).replace(/\s+/g, ' ');
    if (m.model) model = m.model;
    if (m.usage) tokens += (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0);
    count++;
    if (wantMessages && text) msgs.push({ role: m.role, text: text.slice(0, 4000), ts, model: m.model || '' });
  }
  if (!count) return null;
  const out = { id, title: title || tr('srv.untitled'), first, last, messages: count, model, tokens };
  if (wantMessages) out.items = msgs.slice(-400);
  return out;
}

async function listHistory(name) {
  if (!validName(name)) return { ok: false, msg: tr('srv.badName') };
  const dir = dirOf(name);
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { return { ok: true, sessions: [], dir }; }
  const sessions = (await Promise.all(files.map((f) => summarizeFile(f, false)))).filter(Boolean).sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  return { ok: true, sessions, dir };
}
async function readConversation(name, id) {
  if (!validName(name) || !/^[A-Za-z0-9_-]{6,80}$/.test(String(id || ''))) return { ok: false, msg: tr('srv.badParams') };
  const file = path.join(dirOf(name), id + '.jsonl');
  const s = await summarizeFile(file, true);
  if (!s) return { ok: false, msg: tr('srv.convNotFound') };
  return { ok: true, conversation: s };
}
// Continuar: grava ~/.claude/run/<sess>.resume com o id e RECRIA a sessao; o claude-loop.sh, ao
// abrir o Claude, usa `claude --resume <id>`. (Antes mandava Ctrl-C x2, que falhava com o Claude
// ocupado ou com texto no prompt.) Sessao so com shell (Claude OFF): manda o comando direto.
async function resumeConversation(name, id, running) {
  if (!validName(name) || !/^[A-Za-z0-9_-]{6,80}$/.test(String(id || ''))) return { ok: false, msg: tr('srv.badParams') };
  const sess = sessionName(name);
  if (!(await sh('tmux', ['has-session', '-t', '=' + sess])).ok) return { ok: false, msg: tr('srv.tmuxDown') };
  if (running) {
    fs.mkdirSync(cfg.RUN_DIR, { recursive: true });
    fs.writeFileSync(path.join(cfg.RUN_DIR, sess + '.resume'), id + '\n');
    await require('./projects').recreateSession(name); // lazy: evita ciclo de require
    return { ok: true, msg: tr('srv.resumed', { name, id: id.slice(0, 8) }) };
  }
  await sh('tmux', ['send-keys', '-t', paneOf(sess), '-l', `claude --resume ${id}`]);
  await sh('tmux', ['send-keys', '-t', paneOf(sess), 'C-m']);
  return { ok: true, msg: tr('srv.resumeSent', { name }) };
}

module.exports = { listHistory, readConversation, resumeConversation };
