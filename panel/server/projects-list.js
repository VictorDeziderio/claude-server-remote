'use strict';
// Project list = subfolders of PROJECTS_DIR. Separate file to avoid a cycle between usage.js and
// projects.js. The same rule lives in claude-session.sh (is_project_dir), which starts the sessions;
// tests/claude-loop.test.sh and panel/test/smoke.mjs check both.
//
// Not a project (Claude Code creates these next to a project, e.g. `git worktree add ../app.fix`):
//   - hidden folders (.name)
//   - a linked git worktree: its `.git` is a FILE ("gitdir: ...") instead of a folder
//   - "<project>.<anything>" next to an existing <project> (a worktree, even after it was removed)
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

function isProjectDir(name, names) {
  if (!name || name.startsWith('.')) return false;
  try { if (fs.lstatSync(path.join(cfg.PROJECTS_DIR, name, '.git')).isFile()) return false; } catch { /* no .git */ }
  const dot = name.indexOf('.');
  if (dot > 0 && names.has(name.slice(0, dot))) return false;
  return true;
}

function listProjects() {
  try {
    const dirs = fs.readdirSync(cfg.PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const names = new Set(dirs);
    return dirs.filter((n) => isProjectDir(n, names)).sort();
  } catch { return []; }
}

module.exports = { listProjects };
