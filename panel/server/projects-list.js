'use strict';
// Project list = (non-hidden) subfolders of PROJECTS_DIR. Separate file to avoid a cycle
// between usage.js and projects.js.
const fs = require('fs');
const cfg = require('./config');

function listProjects() {
  try {
    return fs.readdirSync(cfg.PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  } catch { return []; }
}

module.exports = { listProjects };
