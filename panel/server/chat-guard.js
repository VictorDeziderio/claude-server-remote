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
// files that make the NEXT Claude/git/tool run execute something: writing them from a limited link
// would turn file access into running commands (paths relative to the project, '/' separators).
const PROTECTED = [
  /(^|\/)\.claude(\/|$)/, /(^|\/)\.mcp\.json$/, /(^|\/)CLAUDE(\.local)?\.md$/, // Claude settings hooks, MCP servers, instructions
  /(^|\/)\.git(\/|$)/, /(^|\/)\.husky(\/|$)/, /(^|\/)\.pre-commit-config\.ya?ml$/, // git hooks (and the hook managers)
  /(^|\/)\.github(\/|$)/, /(^|\/)\.gitlab-ci\.ya?ml$/, // CI runs it with the repo's secrets
  /(^|\/)package(-lock)?\.json$/, /(^|\/)npm-shrinkwrap\.json$/, /(^|\/)\.npmrc$/, /(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/, // npm scripts / install sources
  /(^|\/)\.envrc$/, /(^|\/)(GNUmakefile|makefile|Makefile)$/i, /(^|\/)\.vscode(\/|$)/, /(^|\/)\.devcontainer(\/|$)/, // direnv, make, editor tasks
  /(^|\/)Dockerfile[^/]*$/i, /(^|\/)(docker-)?compose[^/]*\.ya?ml$/i, // container builds
  /^[^/]+\.sh$/, // scripts at the project root (the usual ./deploy.sh, ./start.sh)
];

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

// raw hook input -> reason to deny ('' = allow). FAIL CLOSED: anything unexpected (bad JSON, an
// exception inside the checks) denies — exit 0 is the hook protocol for "allow", so a crash that
// ended with any other code than 2 must never be the way out.
function decide(raw, project, checkFn = check) {
  let ev = null;
  try { ev = JSON.parse(raw); } catch { /* invalid -> deny */ }
  if (!ev || typeof ev !== 'object') return 'invalid hook input';
  try { return checkFn(ev, project); } catch (e) { return `chat guard error, tool call refused: ${(e && e.message) || e}`; }
}
const deny = (why) => { try { process.stderr.write(why + '\n'); } catch { /* */ } process.exit(2); };

if (require.main === module) {
  process.on('uncaughtException', (e) => deny(`chat guard error, tool call refused: ${(e && e.message) || e}`));
  const project = path.resolve(process.argv[2] || '/nonexistent');
  let data = '';
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('error', () => deny('chat guard could not read the hook input'));
  process.stdin.on('end', () => {
    const why = decide(data, project);
    if (why) return deny(why);
    process.exit(0);
  });
}

module.exports = { check, decide, PROTECTED };
