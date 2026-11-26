'use strict';
/*
 * Reading Claude Code's terminal screen (the text of `tmux capture-pane -p -J`).
 *
 *  - parseQuestion(screen): the menu Claude shows when it asks something (permission prompt,
 *    AskUserQuestion, "Do you want to make this edit?") -> { question, detail, options:[{n, label,
 *    desc}], cursor, multi, sig } or null. The menu must be the LAST thing on the screen: numbered
 *    options "1. ...", "2. ..." in order, one of them with the cursor (❯), and below them only
 *    blank lines, separators, option descriptions and key hints ("Esc to cancel"). A numbered list
 *    inside Claude's answer always has the input box under it, so it never counts.
 *  - looksLikePrompt(screen): Claude seems to wait for an answer but the menu could not be read
 *    (PROMPT_RX on the bottom lines). The chat then shows the screen text with quick keys.
 *  - isWorking(screen): the "esc to interrupt" status / the spinner line of a turn in progress.
 *
 * PROMPT_RX is also used by the tmux watcher (events.js): one rule, one place.
 */

// patterns on screen that mean "Claude waiting for YOU" (permission/confirmation/choice)
// (the /remote-control dialog — "Esc to continue" — does NOT count: the loop/panel close it by themselves)
const PROMPT_RX = /(Do you want to (proceed|allow|make this edit|run|create|continue)|Allow (this|the) |Yes, (and )?(don't|allow|proceed)|^\s*(❯\s*)?1\.\s*Yes\b|\(y\/n\)|\[Y\/n\]|Would you like to|permission to|Waiting for (your )?(input|approval))/im;

const OPT_RX = /^(\s*)([❯›>]\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/;
// separator lines: rules and box edges (a dialog's top border ends the context)
const SEP_RX = /^[─━═╌┄┈╍┅╴╶\-_\s]{3,}$|^[╭┌][─━]*[╮┐]?$|^[╰└][─━]*[╯┘]?$/;
const HARD_SEP_RX = /^[─━═]{8,}$|^[╭┌]/;
const HINT_RX = /\b(esc|enter|tab|ctrl|navigate|select|cancel|confirm|submit)\b|[↑↓←→]/i;
const WORKING_RX = /\besc to interrupt\b/i;
const SPINNER_RX = /^\s*[✻✶✳✢✽·*]\s+\S+…/;

// "│ text │" -> "text" (boxed dialogs of older Claude Code versions), tabs as spaces, no right padding
const clean = (l) => String(l).replace(/\t/g, '    ').replace(/^(\s*)[│┃](\s?)/, '$1 $2').replace(/\s*[│┃]\s*$/, '').replace(/\s+$/, '');
const indentOf = (l) => l.length - l.trimStart().length;
const MAX_LABEL = 200;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function linesOf(screen) {
  const lines = String(screen || '').replace(/\r/g, '').split('\n').map(clean);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function parseQuestion(screen) {
  const lines = linesOf(screen);
  if (!lines.length) return null;
  const opts = []; // bottom -> top while walking, reversed at the end
  let pending = []; // description lines under an option (seen before the option, walking up)
  let i = lines.length - 1;
  let minIndent = Infinity;
  for (; i >= 0 && lines.length - i <= 60; i--) {
    const l = lines[i];
    const t = l.trim();
    const m = OPT_RX.exec(l);
    if (m) {
      const ind = m[1].length + (m[2] ? m[2].length : 0); // the number column, with or without the cursor
      opts.push({ n: Number(m[3]), label: clip(m[4], MAX_LABEL), cur: !!m[2], desc: pending.reverse().join(' ') });
      pending = [];
      minIndent = Math.min(minIndent, ind);
      continue;
    }
    if (!t || SEP_RX.test(t)) continue;
    if (!opts.length) {
      // below the last option: key hints, or the description of that last option
      if (HINT_RX.test(t) && t.length <= 160 && !/^[❯›>]\s*$/.test(t)) continue;
      if (indentOf(l) >= 4) { pending.push(t); continue; }
      return null;
    }
    // above some options: a description line (indented past the number column) or the question
    if (indentOf(l) >= minIndent + 2 && !/^[❯›>]/.test(t)) { pending.push(t); continue; }
    break;
  }
  if (opts.length < 2) return null;
  opts.reverse();
  // the numbers go 1..k in order and exactly one option has the cursor
  if (!opts.every((o, k) => o.n === k + 1)) return null;
  const cursors = opts.filter((o) => o.cur);
  if (cursors.length !== 1) return null;
  // the descriptions collected above the FIRST option belong to the question, not to an option
  const questionLines = [];
  let j = i;
  for (; j >= 0 && !lines[j].trim(); j--);
  for (; j >= 0 && questionLines.length < 6; j--) {
    const t = lines[j].trim();
    if (!t || SEP_RX.test(t)) break;
    questionLines.unshift(t);
  }
  if (!questionLines.length && pending.length) questionLines.push(...pending.reverse());
  const detail = [];
  for (let n = 0; j >= 0 && n < 24 && detail.length < 14; j--, n++) {
    const t = lines[j].trim();
    if (HARD_SEP_RX.test(t)) break;
    if (SEP_RX.test(t)) continue;
    if (!t && (!detail.length || !detail[0])) continue; // collapse blank lines
    detail.unshift(t);
  }
  while (detail.length && !detail[0]) detail.shift();
  const question = clip(questionLines.join(' '), 400);
  const options = opts.map((o) => ({ n: o.n, label: o.label, desc: clip(o.desc, 240) }));
  const multi = options.some((o) => /^\[[ x✔✓]?\]/.test(o.label));
  // what the person saw: an answer is only typed if the screen still shows the same question
  const sig = require('crypto').createHash('sha1').update(question + '\n' + options.map((o) => o.label).join('\n')).digest('hex').slice(0, 16);
  return { question, detail: detail.join('\n').trim(), options, cursor: cursors[0].n, multi, sig };
}

const bottom = (screen, n) => linesOf(screen).filter((l) => l.trim()).slice(-n);
const looksLikePrompt = (screen) => PROMPT_RX.test(bottom(screen, 15).join('\n'));
const isWorking = (screen) => bottom(screen, 14).some((l) => WORKING_RX.test(l) || SPINNER_RX.test(l));
// the bottom of the screen as plain text (shown when the menu cannot be read)
const screenTail = (screen, n = 20) => bottom(screen, n).join('\n');

module.exports = { PROMPT_RX, parseQuestion, looksLikePrompt, isWorking, screenTail };
