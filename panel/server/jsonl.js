'use strict';
// Reading Claude conversation files (*.jsonl) without loading huge ones whole.
//
// A project that always continues the same conversation (`claude --continue`) ends up with ONE file
// of gigabytes. Small files are read whole; a big one is read by windows of bytes: the head (title,
// first date) and a window that ends at a byte offset (the newest messages, then older ones as the
// reader goes back). Lines cut by a window edge are dropped, so every returned line is complete JSON.
const fsp = require('fs/promises');

const BIG = 32 * 1024 * 1024;     // above this a file is read by windows
const WINDOW = 4 * 1024 * 1024;   // bytes per window

async function readRange(file, start, end) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

// lines of [start, end) as [{ line, off }] (off = byte offset of the line in the file)
function linesOf(buf, base, { cutHead, cutTail }) {
  const out = [];
  let i = 0;
  if (cutHead) { const nl = buf.indexOf(10); if (nl < 0) return out; i = nl + 1; }
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) { if (!cutTail) out.push({ line: buf.subarray(i).toString('utf8'), off: base + i }); break; }
    if (nl > i) out.push({ line: buf.subarray(i, nl).toString('utf8'), off: base + i });
    i = nl + 1;
  }
  return out;
}

// the first `bytes` of the file
async function head(file, size, bytes = 2 * 1024 * 1024) {
  const end = Math.min(size, bytes);
  return linesOf(await readRange(file, 0, end), 0, { cutHead: false, cutTail: end < size });
}

// the window that ends at `end` (default: end of file) -> { lines, start } (start = offset of the
// first returned line, 0 when the window reached the beginning of the file)
async function windowBefore(file, size, end = size, bytes = WINDOW) {
  end = Math.max(0, Math.min(end, size));
  const start = Math.max(0, end - bytes);
  const lines = linesOf(await readRange(file, start, end), start, { cutHead: start > 0, cutTail: false });
  return { lines, start: lines.length ? lines[0].off : start };
}

// whole file -> [{ line, off }]
async function all(file) {
  const buf = await fsp.readFile(file);
  return linesOf(buf, 0, { cutHead: false, cutTail: false });
}

// ---------------------------------------------------------------- conversation title
// A project resumed with "continue" (by hand or by the auto-resume) starts many conversations with
// that word, so "the first user message" is a poor title. The pick, best first: the name given with
// /rename (a custom-title line; the newest wins), the first real request, Claude's own summary line,
// the newest real request. Resume words and slash-command echoes never count as requests.
const RESUME_WORDS = /^(continue|continua|continuar|continue de onde parou|go on|keep going|resume|retome|retomar|siga|segue|ok|okay|sim|yes|y|s)[\s.!]*$/i;
function isTrivialPrompt(text) {
  const t = String(text || '').trim();
  const own = String(process.env.AUTO_RESUME_TEXT || '').trim();
  return !t || RESUME_WORDS.test(t) || (own && t === own) || t.startsWith('[') || /^<[a-z-]+>/.test(t);
}
function titler() {
  const s = { custom: '', first: '', summary: '', latest: '' };
  const clean = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 120);
  return {
    // any parsed line (custom-title / summary records)
    line(o) {
      if (!o) return;
      if (o.type === 'custom-title' && o.customTitle) s.custom = clean(o.customTitle);
      else if (o.type === 'summary' && o.summary) s.summary = clean(o.summary);
    },
    // the text of a user message
    user(text) {
      if (isTrivialPrompt(text)) return;
      if (!s.first) s.first = clean(text);
      s.latest = clean(text);
    },
    state: () => ({ ...s }),
  };
}
// best title from one or more titler states (in file order: a later custom title wins)
function pickTitle(...states) {
  const by = (k, last) => { const v = states.map((x) => x && x[k]).filter(Boolean); return last ? v[v.length - 1] : v[0]; };
  return by('custom', true) || by('first') || by('summary', true) || by('latest', true) || '';
}

module.exports = { BIG, WINDOW, head, windowBefore, all, isTrivialPrompt, titler, pickTitle };
