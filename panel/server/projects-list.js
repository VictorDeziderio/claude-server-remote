'use strict';
// Lista de projetos = subpastas (nao ocultas) de PROJECTS_DIR. Separado p/ evitar ciclo
// entre usage.js e projects.js.
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
