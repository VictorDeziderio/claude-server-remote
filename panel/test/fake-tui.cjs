#!/usr/bin/env node
// Stand-in for Claude Code's terminal UI inside a tmux pane (test/chat.test.mjs; never the real
// Claude). Raw mode like the real TUI: every input chunk is appended to $FAKE_TUI_LOG as a JSON
// line {"d": "<chunk>"} (so the test sees exactly which keys the chat typed), bracketed paste is
// requested like the real one does, and the screen shows the text of $FAKE_TUI_SCREEN, redrawn
// whenever that file changes (the test "puts" a question / a working spinner on the screen).
const fs = require('fs')

const LOG = process.env.FAKE_TUI_LOG
const SCREEN = process.env.FAKE_TUI_SCREEN
process.stdout.write('\x1b[?2004h')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (b) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ d: b.toString('utf8') }) + '\n') })
let last = null
const draw = () => {
  let t = ''
  try { t = fs.readFileSync(SCREEN, 'utf8') } catch { /* nothing to show */ }
  if (t === last) return
  last = t
  process.stdout.write('\x1b[H\x1b[2J' + t.replace(/\n/g, '\r\n'))
}
draw()
setInterval(draw, 100)
