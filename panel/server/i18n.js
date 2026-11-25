'use strict';
// Mensagens do servidor no idioma de quem pediu, com as MESMAS chaves e arquivos da interface
// (src/locales/<codigo>.json, chaves "srv.*"). O navegador manda o idioma no cookie cr_lang
// (src/lib/i18n.js); sem cookie vale o Accept-Language e, por fim, o ingles.
// Cada requisicao roda dentro de withLang(req, fn); qualquer modulo chama tr('srv.x', {vars}).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const core = require('../src/lib/i18n-core.js'); // mesmas regras do navegador (pickLang/format/lookup)

const DIR = process.env.PANEL_LOCALES_DIR || path.join(__dirname, '..', 'src', 'locales');
const DEFAULT = 'en';
let LOCALES = {};
function load() {
  LOCALES = {};
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try { LOCALES[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { /* arquivo quebrado: ignora esse idioma */ }
    }
  } catch { /* sem pasta: so as chaves */ }
}
load();

const als = new AsyncLocalStorage();
const cookieLang = (req) => {
  const m = /(?:^|;\s*)cr_lang=([A-Za-z-]{2,10})/.exec((req && req.headers && req.headers.cookie) || '');
  return m ? m[1] : '';
};
function pickLang(req) {
  const accept = String((req && req.headers && req.headers['accept-language']) || '').split(',').map((s) => s.split(';')[0].trim());
  return core.pickLang(cookieLang(req), accept, Object.keys(LOCALES), DEFAULT);
}
const withLang = (req, fn) => als.run(pickLang(req), fn);
const current = () => als.getStore() || DEFAULT;
// texto da chave no idioma da requisicao atual (reserva: ingles, depois a propria chave)
const tr = (key, vars, lang) => String(core.lookup(LOCALES, lang || current(), DEFAULT, key, vars));
// como tr, mas `fallback` quando nenhum idioma tem a chave
const trOr = (key, fallback, vars, lang) => (key in (LOCALES[lang || current()] || {}) || key in (LOCALES[DEFAULT] || {}) ? tr(key, vars, lang) : fallback);

module.exports = { tr, trOr, withLang, pickLang, current, load, DEFAULT };
