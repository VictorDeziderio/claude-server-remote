'use strict';
// Server messages in the language of whoever asked, with the SAME keys and files as the interface
// (src/locales/<code>.json, "srv.*" keys). The browser sends the language in the cr_lang cookie
// (src/lib/i18n.js); without a cookie Accept-Language applies and, last, English.
// Each request runs inside withLang(req, fn); any module calls tr('srv.x', {vars}).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const core = require('../src/lib/i18n-core.js'); // same rules as the browser (pickLang/format/lookup)

const DIR = process.env.PANEL_LOCALES_DIR || path.join(__dirname, '..', 'src', 'locales');
const DEFAULT = 'en';
let LOCALES = {};
function load() {
  LOCALES = {};
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try { LOCALES[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { /* broken file: skip this language */ }
    }
  } catch { /* no folder: keys only */ }
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
// text of the key in the current request's language (fallback: English, then the key itself)
const tr = (key, vars, lang) => String(core.lookup(LOCALES, lang || current(), DEFAULT, key, vars));
// like tr, but `fallback` when no language has the key
const trOr = (key, fallback, vars, lang) => (key in (LOCALES[lang || current()] || {}) || key in (LOCALES[DEFAULT] || {}) ? tr(key, vars, lang) : fallback);

module.exports = { tr, trOr, withLang, pickLang, current, load, DEFAULT };
