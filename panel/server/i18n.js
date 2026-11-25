'use strict';
// Mensagens do servidor no idioma de quem pediu, com as MESMAS chaves e arquivos da interface
// (src/locales/<codigo>.json, chaves "srv.*"). O navegador manda o idioma no cookie cr_lang
// (src/lib/i18n.js); sem cookie vale o Accept-Language e, por fim, o ingles.
// Cada requisicao roda dentro de withLang(req, fn); qualquer modulo chama tr('srv.x', {vars}).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

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
  const avail = Object.keys(LOCALES);
  const want = [cookieLang(req), ...String((req && req.headers && req.headers['accept-language']) || '').split(',').map((s) => s.split(';')[0].trim())];
  for (const l of want) {
    if (!l) continue;
    if (avail.includes(l)) return l;
    const base = l.split('-')[0].toLowerCase();
    const hit = avail.find((a) => a.split('-')[0].toLowerCase() === base);
    if (hit) return hit;
  }
  return DEFAULT;
}
const withLang = (req, fn) => als.run(pickLang(req), fn);
const current = () => als.getStore() || DEFAULT;
const format = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : String(s));
// tr = "translate": texto da chave no idioma da requisicao atual (reserva: ingles, depois a chave)
function tr(key, vars, lang) {
  const l = lang || current();
  const v = (LOCALES[l] && LOCALES[l][key]) ?? (LOCALES[DEFAULT] && LOCALES[DEFAULT][key]) ?? key;
  return format(v, vars);
}

module.exports = { tr, withLang, pickLang, current, load, DEFAULT };
