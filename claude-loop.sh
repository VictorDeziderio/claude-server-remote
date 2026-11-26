#!/usr/bin/env bash
# Claude supervisor of ONE tmux session (multi-tmux model: 1 session per project).
#
# Runs Claude in a loop: if it exits (exit/crash), it reopens in 3s. The project config
# (panel.json) is REREAD on each start, so what changed in the panel applies without recreating the session:
#   - enabled=false or autoStartClaude=false -> does not reopen: drops to a shell in the folder
#   - autoRemote=true -> once the TUI is ready, sends /remote-control <name> (if logged in)
#   - initLine        -> goes as the initial prompt (`claude "<line>"`)
#   - <session>.resume -> `claude --resume <id>` (History -> "Continue" in the panel)
# Ctrl-C in the 3s window between one Claude and the next also drops to the shell.
#
# Flag ~/.claude/run/<session>.running exists while Claude runs (the panel reads this flag).
# Supervisor log (remote sending etc.): ~/.claude/logs/sessions.log (panel -> Logs).
#
# Usage: claude-loop.sh <session> <project>
set -uo pipefail

LIB="${DEVBOX_LIB:-/usr/local/lib/devbox/lib.sh}"
# shellcheck source=devbox-lib.sh
. "$LIB"

SESS="${1:?usage: claude-loop.sh <session> <project>}"
PROJ_NAME="${2:?usage: claude-loop.sh <session> <project>}"
DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"
RUN_FLAG="$RUN_DIR/$SESS.running"
RESUME_FLAG="$RUN_DIR/$SESS.resume"
PAUSE_FLAG="$RUN_DIR/$SESS.paused"
mkdir -p "$RUN_DIR" "$LOG_DIR"

gray() { printf '\033[90m%s\033[0m\n' "$*"; }
# log to a file (NEVER to the terminal while Claude is on screen: it would mess up the TUI)
slog() { printf '[%s] %s: %s\n' "$(date '+%F %T')" "$SESS" "$*" >> "$LOG_DIR/sessions.log"; }

# ---------- reading the screen (tmux) ----------
screen() { tmux capture-pane -t "=$SESS:" -p -S -80 2>/dev/null; }
# Claude's TUI ready to take a command? (footer/prompt visible)
tui_ready() { screen | grep -qE '(\? for shortcuts|bypass permissions|shift\+tab to cycle|^[[:space:]]*[>❯][[:space:]]*$)'; }
# remote already active? (remote-control link or status on screen)
remote_up() { screen | grep -qE '(claude\.ai/code/|[Rr]emote[- ]control (is )?(on|active|enabled|started|conectado|ativo))'; }
# /remote-control opens a dialog ("Disconnect this session / Show QR code / > Continue",
# "Enter to select · Esc to continue") that blocks the prompt until someone presses Enter/Esc.
dialog_open() { screen | grep -qE '(Esc to continue|Disconnect this session|Show QR code)'; }
# Claude Code 2.1.28x+: /remote-control asks for CONFIRMATION ("❯ 1. Enable Remote Control / 2. Never
# mind"). Enter accepts option 1 (the default); Esc here would be "Never mind".
confirm_open() { screen | grep -qE '❯[[:space:]]*1\.[[:space:]]*Enable Remote Control'; }
dismiss_dialog() {
  for _ in 1 2 3 4 5; do
    dialog_open || return 0
    tmux send-keys -t "=$SESS:" Escape
    sleep 1
  done
}

# New workspace (found by @qa 2026-09-29, live): the first time Claude opens a folder it
# asks "Is this project you created or one you trust?" with a menu WITHOUT numbers where the
# default item (cursor "❯") is "No, exit" -- without this automation, EVERY new session hangs waiting
# for someone to click "Yes, I trust this folder" by hand in the web terminal (the panel runs
# nothing — not even /remote-control — while this dialog is on screen). Automated: sends
# Down (moves the cursor to "Yes, I trust this folder") + Enter.
trust_prompt_open() { screen | grep -qE 'Is this project you created or one you trust|trust this folder'; }
accept_trust_prompt() {
  local waited=0
  until trust_prompt_open; do
    tui_ready && return 0                    # workspace already trusted -> it never showed up
    sleep 1; waited=$((waited + 1))
    [ "$waited" -ge 60 ] && return 0          # did not show up in 60s -> do not insist
  done
  for _ in 1 2 3 4 5; do
    trust_prompt_open || { slog "trust: workspace trusted, TUI unlocked"; return 0; }
    tmux send-keys -t "=$SESS:" Down
    sleep 0.3
    tmux send-keys -t "=$SESS:" Enter
    sleep 1
  done
  slog "trust: the trust dialog did not go away after 5 tries — check it by hand"
}

# Waits for the TUI to be ready (reads the screen instead of a fixed sleep), sends /remote-control
# (text and Enter in two steps: the TUI must process the text before the Enter), confirms
# through the link on screen and tries up to 3x. Not logged in: does not send.
send_remote_when_ready() {  # $1 = command
  local cmd="$1" waited=0 attempt
  sleep "$DELAY"
  is_logged_in || { slog "remote: Claude is not logged in — did not send $cmd"; return 0; }
  until tui_ready; do
    sleep 3; waited=$((waited + 3))
    [ "$waited" -ge 120 ] && { slog "remote: TUI not ready after 120s — sending anyway"; break; }
  done
  for attempt in 1 2 3; do
    remote_up && { slog "remote: already on"; dismiss_dialog; return 0; }
    tmux send-keys -t "=$SESS:" -l "$cmd"
    sleep 0.8
    tmux send-keys -t "=$SESS:" C-m
    # up to 12s: confirms the new dialog (if it shows up) and waits for the link
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep 1
      if confirm_open; then slog "remote: confirming 'Enable Remote Control'"; tmux send-keys -t "=$SESS:" Enter; fi
      remote_up && break
    done
    if remote_up; then slog "remote: on (attempt $attempt)"; dismiss_dialog; return 0; fi
    tmux send-keys -t "=$SESS:" C-u 2>/dev/null || true   # line left typed? clear it and try again
    sleep 5
  done
  slog "remote: not confirmed after $attempt attempts (use 'Restart remote' in the panel)"
}

# ---------- automatic rollback of the Claude Code version ----------
# Every new image brings the "latest" Claude. If it crash-loops, it goes back ONCE to the last
# version that ran healthy here (saved on the volume) -- the build already rejects a broken binary; this
# covers what only breaks in use. One attempt per version (flag), serialized across projects (flock).
GOOD_FILE="$RUN_DIR/claude-good-version"
claude_ver() { claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
record_good_claude() {
  local v; v="$(claude_ver)"
  [ -n "$v" ] && [ "$(cat "$GOOD_FILE" 2>/dev/null)" != "$v" ] && printf '%s\n' "$v" > "$GOOD_FILE"
  return 0
}
rollback_claude() {
  local cur good tried
  good="$(cat "$GOOD_FILE" 2>/dev/null)"; cur="$(claude_ver)"
  [ -n "$good" ] && [ -n "$cur" ] && [ "$good" != "$cur" ] || return 1
  tried="$RUN_DIR/claude-rollback-tried-$cur"
  [ -e "$tried" ] && return 1
  : > "$tried"
  slog "rollback: Claude $cur in a crash-loop — going back to $good (last healthy)"
  if ( flock 8; timeout 300 sudo -n npm install -g --include=optional "@anthropic-ai/claude-code@$good" ) \
       8>"$RUN_DIR/claude-rollback.lock" >>"$LOG_DIR/sessions.log" 2>&1 && [ "$(claude_ver)" = "$good" ]; then
    alert warn claude-update "$PROJ_NAME" "Claude $cur kept crashing — automatically went back to $good." srv.alert.rolledBack "cur=$cur" "good=$good"
    return 0
  fi
  alert error claude-update "$PROJ_NAME" "Claude $cur kept crashing and going back to $good failed — see Logs → Sessions." srv.alert.rollbackFailed "cur=$cur" "good=$good"
  return 1
}

# drops to an interactive shell in the folder (the tmux session stays alive)
drop_to_shell() {
  rm -f "$RUN_FLAG"
  gray "$*"
  exec bash -l
}

REMOTE_PID=""
TRUST_PID=""
cleanup() {
  rm -f "$RUN_FLAG"
  [ -n "$REMOTE_PID" ] && kill "$REMOTE_PID" 2>/dev/null
  [ -n "$TRUST_PID" ] && kill "$TRUST_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 0' TERM HUP

FAILS=0  # in a row; reset when Claude runs long enough (see backoff_next)
while true; do
  load_proj_config "$PROJ_NAME"
  if [ "$CFG_ENABLED" != "true" ] || [ "$CFG_AUTOSTART" != "true" ]; then
    drop_to_shell "[dev-box] Claude is OFF for \"$PROJ_NAME\" in the panel — free shell. Run  claude  whenever you want."
  fi

  # Paused (inactivity or "Pause" in the panel): does not reopen until the panel removes the flag or someone
  # presses Enter here. The conversation stays saved -- with a pinned/continue session it comes back where it stopped.
  if [ -e "$PAUSE_FLAG" ]; then
    rm -f "$RUN_FLAG"
    slog "paused ($(head -c 20 "$PAUSE_FLAG" 2>/dev/null)) — waiting to resume"
    gray "[Claude paused ($(head -c 20 "$PAUSE_FLAG" 2>/dev/null)) — press Enter here or 'Resume' in the panel]"
    while [ -e "$PAUSE_FLAG" ]; do
      if read -r -t 5 _; then rm -f "$PAUSE_FLAG"; fi
    done
    FAILS=0
    slog "resumed"
  fi

  # accepts "trust this folder" by itself (always runs, even without remote): without it nothing else
  # in this session moves on -- the TUI never gets ready, and the /remote-control below cannot run
  accept_trust_prompt &
  TRUST_PID=$!

  # remote-control in parallel with claude (waits for the TUI to be ready)
  REMOTE_PID=""
  if [ "$CFG_REMOTE" = "true" ]; then
    send_remote_when_ready "$(remote_cmd "$PROJ_NAME")" &
    REMOTE_PID=$!
  fi

  RESUME_ID=""
  if [ -s "$RESUME_FLAG" ]; then
    # only the first line (head -c truncated by BYTES, not by line: leftovers of a concurrent write
    # or junk after the id became part of the id and --resume failed silently with an invalid id)
    RESUME_ID="$(head -n1 "$RESUME_FLAG" | tr -cd 'A-Za-z0-9_-')"
    rm -f "$RESUME_FLAG"
    # expected format (history.js): ^[A-Za-z0-9_-]{6,80}$ — anything else is ignored instead of
    # trying a --resume with a broken id
    [[ "$RESUME_ID" =~ ^[A-Za-z0-9_-]{6,80}$ ]] || {
      [ -n "$RESUME_ID" ] && slog "resume: flag has an invalid format, ignoring ($RESUME_ID)"
      RESUME_ID=""
    }
  fi

  # Pinned session (panel.json -> sessionMode): History's "Continue" (RESUME_ID) wins; otherwise
  # "pinned" always reopens the chosen conversation and "continue" the folder's most recent one. It only resumes
  # what exists on disk: --continue/--resume without a conversation would exit at once and count as a crash.
  CONTINUE=""
  CDIR="$(conv_dir "$PWD")"
  if [ -z "$RESUME_ID" ] && [ "$CFG_SESSMODE" = "pinned" ]; then
    if [ -n "$CFG_PINNED" ] && [ -f "$CDIR/$CFG_PINNED.jsonl" ]; then
      RESUME_ID="$CFG_PINNED"
    else
      slog "pinned session: conversation '${CFG_PINNED:-?}' not found — opening a new one"
    fi
  elif [ -z "$RESUME_ID" ] && [ "$CFG_SESSMODE" = "continue" ]; then
    if compgen -G "$CDIR/*.jsonl" >/dev/null; then CONTINUE=1
    else slog "continue: no previous conversation in this folder — opening a new one"; fi
  fi

  : > "$RUN_FLAG"
  slog "claude started${RESUME_ID:+ (resume $RESUME_ID)}${CONTINUE:+ (continue)}"
  T0=$(date +%s)
  # resuming a conversation, the "first line" is NOT sent again (it would repeat the request on every restart)
  if [ -n "$RESUME_ID" ]; then
    gray "[continuing conversation $RESUME_ID]"
    claude --resume "$RESUME_ID"
  elif [ -n "$CONTINUE" ]; then
    gray "[continuing the last conversation in this folder]"
    claude --continue
  elif [ -n "$CFG_INITLINE" ]; then
    # interactive, already running the first line; "-..." would become a CLI flag -> a space in front
    case "$CFG_INITLINE" in -*) CFG_INITLINE=" $CFG_INITLINE" ;; esac
    claude "$CFG_INITLINE"
  else
    claude
  fi
  rc=$?
  RAN_FOR=$(( $(date +%s) - T0 ))
  # exit code in the log: 0 = normal exit (/exit, Ctrl-D); 137 = SIGKILL (OOM/kill); 134 = abort
  # (e.g. V8 heap out of memory); 129/143 = HUP/TERM. Without it a dropped session leaves no clue.
  slog "claude exited (code $rc, ran ${RAN_FOR}s)"
  rm -f "$RUN_FLAG"
  # sending remote/trust belongs to THIS Claude: if it already exited, it must not type into the next one
  if [ -n "$REMOTE_PID" ]; then kill "$REMOTE_PID" 2>/dev/null; wait "$REMOTE_PID" 2>/dev/null; REMOTE_PID=""; fi
  if [ -n "$TRUST_PID" ]; then kill "$TRUST_PID" 2>/dev/null; wait "$TRUST_PID" 2>/dev/null; TRUST_PID=""; fi

  # Backoff: without it, a Claude that crashes fast (bug/OOM) reopens every 3s FOREVER and
  # alone overloads the machine (CPU+memory of each reopen, no ceiling). Runs long
  # enough (MIN_HEALTHY_RUN_S) -> resets the counter, it was normal use.
  FAILS="$(backoff_next "$FAILS" "$RAN_FOR")"
  [ "$FAILS" = "0" ] && record_good_claude
  if [ "$FAILS" -ge "$MAX_FAST_FAILS" ] && rollback_claude; then
    FAILS=0
  fi
  if [ "$FAILS" -ge "$MAX_FAST_FAILS" ]; then
    slog "crash-loop: claude exited $FAILS times in a row too fast — no longer restarting it"
    alert error crash-loop "$PROJ_NAME" "Claude crashed $FAILS times in a row (last code $rc) — stopped restarting it. See Logs → Sessions." srv.alert.crashLoop "n=$FAILS" "rc=$rc"
    drop_to_shell "[dev-box] Claude exited $FAILS times in a row too fast — stopped restarting it so the VM is not overloaded. Free shell; run  claude  whenever you want (or 'Restart' in the panel to start over)."
  fi
  WAIT="$(backoff_sleep "$FAILS")"
  gray "[claude exited — restarting in ${WAIT}s | Ctrl-C = stay in the shell]"
  # Ctrl-C here interrupts the sleep -> drops to the shell (instead of reopening)
  if ! (trap 'exit 130' INT; sleep "$WAIT"); then
    drop_to_shell "[dev-box] supervisor paused — free shell. To come back: 'Restart' in the panel."
  fi
done
