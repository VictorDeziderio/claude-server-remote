#!/usr/bin/env bash
# Claude Code hook -> panel push notifications.
#
# Registered in managed-settings.json for Stop, StopFailure, Notification and UserPromptSubmit.
# Reads the hook JSON from stdin and appends ONE compact line to RUN_DIR/hooks.jsonl, which the
# panel (panel/server/notify.js) polls. The prompt text is never stored.
#
# Must never get in Claude's way: prints nothing (UserPromptSubmit stdout would become context),
# always exits 0 (exit 2 would block the turn), bounded time, works without jq (minimal line).
#
# "tty": 1/0 = the claude process this hook belongs to has / has no controlling terminal
# (interactive TUI in tmux vs `claude -p` started by a script or by another Claude); -1 = unknown.
#
# Usage: devbox-hook.sh <Stop|StopFailure|Notification|UserPromptSubmit>
EV="${1:-}"
case "$EV" in Stop|StopFailure|Notification|UserPromptSubmit) ;; *) exit 0 ;; esac
DIR="${DEVBOX_HOOK_DIR:-${HOME:-/root}/.claude/run}"
OUT="$DIR/hooks.jsonl"
mkdir -p "$DIR" 2>/dev/null || exit 0

input="$(timeout 2 head -c 65536 2>/dev/null)"

tty=-1
p="$PPID"
for _ in 1 2 3 4 5 6; do
  [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ -r "/proc/$p/stat" ] || break
  comm="$(cat "/proc/$p/comm" 2>/dev/null)"
  stat="$(cat "/proc/$p/stat" 2>/dev/null)"
  # fields after "(comm) ": state ppid pgrp session tty_nr ...
  read -r _state ppid _pgrp _sess ttynr _rest <<<"${stat##*) }"
  case "$comm" in
    claude|claude.exe|node) if [ "${ttynr:-0}" != "0" ]; then tty=1; else tty=0; fi; break ;;
  esac
  p="$ppid"
done

now_ms() { local s; s="$(date +%s%3N 2>/dev/null)"; case "$s" in *N|'') echo "$(date +%s)000" ;; *) echo "$s" ;; esac; }

line=""
if command -v jq >/dev/null 2>&1 && [ -n "$input" ]; then
  line="$(printf '%s' "$input" | timeout 3 jq -c --arg ev "$EV" --argjson tty "$tty" --argjson t "$(now_ms)" '{
      t: $t, ev: $ev, tty: $tty,
      cwd: ((.cwd // "") | tostring | .[0:1024]),
      sid: ((.session_id // "") | tostring | .[0:80]),
      src: ((.source // "") | tostring | .[0:20]),
      type: ((.notification_type // "") | tostring | .[0:40]),
      err: ((.error // "") | tostring | .[0:40]),
      bg: ((.background_tasks // []) | if type == "array" then length else 0 end),
      agent: (.agent_id != null),
      msg: ((.message // .last_assistant_message // .error_details // "") | tostring | .[0:300])
    }' 2>/dev/null)"
fi
if [ -z "$line" ]; then
  # no jq / unreadable input: still tell the panel something happened (cwd only if JSON-safe)
  cwd="$PWD"; case "$cwd" in *[!A-Za-z0-9._/-]*) cwd="" ;; esac
  line="$(printf '{"t":%s,"ev":"%s","tty":%s,"cwd":"%s"}' "$(now_ms)" "$EV" "$tty" "$cwd")"
fi
# one short line (< PIPE_BUF) with O_APPEND: concurrent sessions never interleave
printf '%s\n' "$line" >> "$OUT" 2>/dev/null
exit 0
