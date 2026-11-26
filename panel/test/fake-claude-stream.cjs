#!/usr/bin/env node
'use strict';
// FAKE headless `claude -p --output-format stream-json` for test/chat.test.mjs: never the real Claude.
// Prints the same kind of lines as the real CLI (system init with session_id, stream_event text
// deltas, assistant text + tool_use, a user tool_result, result) and writes the conversation to
// ~/.claude/projects/<encoded cwd>/<id>.jsonl like the real one. Every argv goes to
// $HOME/.fake-claude-argv.jsonl (the test checks the flags of the limited role).
// The prompt (stdin) drives it: "SLOW" waits 30s before the answer, "FAIL" exits 1,
// "WRITE <name>" uses the Write tool on <cwd>/<name>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const HOME = process.env.HOME;
fs.appendFileSync(path.join(HOME, '.fake-claude-argv.jsonl'), JSON.stringify({ argv, cwd: process.cwd() }) + '\n');
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const id = opt('--session-id') || opt('--resume');
const dir = path.join(HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, id + '.jsonl');
const uuid = () => crypto.randomUUID();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const rec = (o) => fs.appendFileSync(file, JSON.stringify({ isSidechain: false, sessionId: id, cwd: process.cwd(), timestamp: new Date().toISOString(), uuid: uuid(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: id, tools: ['Read', 'Write'], model: 'claude-fake', permissionMode: opt('--permission-mode') || 'bypassPermissions' });
  rec({ type: 'user', message: { role: 'user', content: prompt } });
  if (prompt.includes('FAIL')) { process.stderr.write('fake failure\n'); process.exit(1); }
  const words = ['Hello', ' from', ' the', ' fake', ' Claude.'];
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant' } }, session_id: id, uuid: uuid() });
  for (const w of words) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }, session_id: id, uuid: uuid() });
    await sleep(prompt.includes('SLOW') ? 400 : 30);
  }
  if (prompt.includes('SLOW')) await sleep(30000);
  const text = words.join('') + ' See https://example.com/docs.';
  const a1 = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] };
  out({ type: 'assistant', message: a1, parent_tool_use_id: null, session_id: id, uuid: uuid() });
  rec({ type: 'assistant', message: a1 });
  const w = /WRITE (\S+)/.exec(prompt);
  if (w) {
    const fp = path.join(process.cwd(), w[1]);
    fs.writeFileSync(fp, 'written by the fake');
    const a2 = { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: fp, content: '...' } }] };
    out({ type: 'assistant', message: a2, parent_tool_use_id: null, session_id: id, uuid: uuid() });
    rec({ type: 'assistant', message: a2 });
    const u = { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'File created' }] };
    out({ type: 'user', message: u, parent_tool_use_id: null, session_id: id, uuid: uuid() });
    rec({ type: 'user', message: u });
  }
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1, result: text, session_id: id, total_cost_usd: 0.001, usage: { input_tokens: 10, output_tokens: 5 } });
  process.exit(0);
});
