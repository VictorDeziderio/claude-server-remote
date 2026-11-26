#!/usr/bin/env node
'use strict';
// PreToolUse hook for the LIMITED chat runs (server/chat.js passes it in --settings).
// Usage: node chat-guard.js <project dir>   (the hook event comes as JSON on stdin)
// Only the file tools are allowed, and only on paths inside the project folder (realpath, so a
// symlink pointing outside is refused). Anything else is blocked: exit 2 + reason on stderr is
// the hook protocol for "deny this tool call". This is the hard wall; the CLI flags
// (--restricted, --tools, --disallowedTools) are the first one.
const fs = require('fs');
const path = require('path');

const ALLOWED = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'TodoWrite']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit']);
// files that make the NEXT Claude/git run execute something (settings hooks, MCP servers, git hooks):
// writing them from a limited link would turn file access into running commands
const PROTECTED = [/(^|\/)\.claude(\/|$)/, /(^|\/)\.mcp\.json$/, /(^|\/)\.git(\/|$)/, /(^|\/)CLAUDE(\.local)?\.md$/];

const inside = (p, base) => p === base || p.startsWith(base + path.sep);
// realpath of p, or of its nearest existing ancestor + the rest (a file still to be created)
function realOf(p) {
  const rest = [];
  let cur = p;
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      rest.push(path.basename(cur)); cur = up;
    }
  }
}
function check(ev, project) {
  const name = String((ev && ev.tool_name) || '');
  if (!ALLOWED.has(name)) return `tool ${name || '?'} is not available on this chat link`;
  const input = (ev && ev.tool_input) || {};
  const base = realOf(project);
  for (const k of PATH_KEYS) {
    if (input[k] == null || input[k] === '') continue;
    const full = path.resolve(project, String(input[k]));
    let lst = null;
    try { lst = fs.lstatSync(full); } catch { /* new file */ }
    let real;
    if (lst && lst.isSymbolicLink()) { try { real = fs.realpathSync(full); } catch { return 'broken symlink refused'; } }
    else real = realOf(full);
    if (!inside(path.resolve(full), path.resolve(project)) || !inside(real, base)) return `path outside the project refused: ${input[k]}`;
    const rel = path.relative(base, real).split(path.sep).join('/');
    if (WRITERS.has(name) && PROTECTED.some((re) => re.test(rel))) return `this file cannot be changed from this chat link: ${input[k]}`;
  }
  // glob patterns: no absolute pattern and no ".." (they could reach outside the project)
  for (const k of ['pattern', 'glob']) {
    if (name !== 'Glob' && k === 'pattern') continue; // Grep's "pattern" is a regex, not a path
    const v = input[k];
    if (typeof v === 'string' && (path.isAbsolute(v) || v.startsWith('~') || v.split(/[/\\]/).includes('..'))) return `pattern outside the project refused: ${v}`;
  }
  return '';
}

if (require.main === module) {
  const project = path.resolve(process.argv[2] || '/nonexistent');
  let data = '';
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    let ev = null;
    try { ev = JSON.parse(data); } catch { /* invalid -> deny */ }
    const why = ev ? check(ev, project) : 'invalid hook input';
    if (why) { process.stderr.write(why + '\n'); process.exit(2); }
    process.exit(0);
  });
}

module.exports = { check };
