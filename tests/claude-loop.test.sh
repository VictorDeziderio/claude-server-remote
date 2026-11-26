#!/usr/bin/env bash
# Tests of the supervisor (claude-loop.sh) + claude-session.sh with a FAKE `claude`, in a temporary
# tmux and HOME — nothing real is touched. Usage: bash tests/claude-loop.test.sh (needs tmux).
set -uo pipefail
# from inside a tmux, $TMUX wins over TMUX_TMPDIR and the `tmux kill-server` below would kill the REAL server
unset TMUX TMUX_PANE
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
export HOME="$T" TMUX_TMPDIR="$T" CLAUDE_AUTOCMD_DELAY=1
# PROJECTS_DIR/PANEL_CONFIG isolated too: devbox-lib.sh only uses $HOME as the default if these
# come EMPTY from the environment -- running this test from inside the real dev box (where start.sh already
# exported the real ones), they leak into the test and it ends up reading/creating a session in the REAL
# project instead of the temporary one (found 2026-10-09, running the tests from inside the dev box itself).
export PROJECTS_DIR="$T/projects" PANEL_CONFIG="$T/.claude/panel.json"
export DEVBOX_LIB="$HERE/devbox-lib.sh" CLAUDE_LOOP="$HERE/claude-loop.sh"
export PATH="$T/bin:$PATH"
mkdir -p "$T/bin" "$T/.claude" "$T/projects/p1"
pass=0 fail=0
ok() { if [ "$2" = "0" ]; then echo "  PASS $1"; pass=$((pass + 1)); else echo "  FAIL $1 ${3:-}"; fail=$((fail + 1)); fi; }
screen() { tmux capture-pane -t '=claude-p1:' -p 2>/dev/null; }
wait_for() {  # $1 = regex, $2 = seconds
  local i
  for ((i = 0; i < $2 * 2; i++)); do screen | grep -qE "$1" && return 0; sleep 0.5; done
  return 1
}
start() { tmux kill-server >/dev/null 2>&1; bash "$HERE/claude-session.sh" p1 </dev/null >/dev/null 2>&1; }
cleanup() { tmux kill-server >/dev/null 2>&1; rm -rf "$T"; }
trap cleanup EXIT

# fake `claude`: prompt ready; /remote-control opens the CONFIRMATION dialog of Claude Code
# 2.1.28x ("❯ 1. Enable Remote Control / 2. Never mind"). Enter confirms, Esc cancels.
cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "? for shortcuts"
while IFS= read -r cmd; do
  case "$cmd" in
    /remote-control*)
      echo "Remote Control"
      echo " ❯ 1. Enable Remote Control   Opens a secure connection to claude.ai."
      echo "   2. Never mind"
      IFS= read -rsn1 k
      if [ -z "$k" ]; then echo "Remote Control active: https://claude.ai/code/session_TEST123"
      else echo "remote cancelled"; fi ;;
  esac
done
EOF
chmod +x "$T/bin/claude"

echo "== remote-control with the confirmation dialog"
echo '{"ok":1}' > "$T/.claude/.credentials.json"   # "logged in"
start
wait_for 'claude\.ai/code/session_TEST123' 25; r=$?
ok "the supervisor confirms 'Enable Remote Control' and remote turns on" "$r" "$(screen | tail -5 | tr '\n' '|')"
screen | grep -q 'remote cancelled'; ok "did not cancel the dialog (Esc = Never mind)" "$([ $? -ne 0 ] && echo 0 || echo 1)"

echo "== not logged in: remote is not sent"
rm -f "$T/.claude/.credentials.json"
start
sleep 4
screen | grep -q '/remote-control\|Remote Control'; ok "not logged in: does not type /remote-control" "$([ $? -ne 0 ] && echo 0 || echo 1)"
grep -q 'not logged in' "$T/.claude/logs/sessions.log" 2>/dev/null; ok "logs the reason in sessions.log" "$?"

echo "== Claude OFF in panel.json -> shell"
echo '{"projects":{"p1":{"autoStartClaude":false}}}' > "$T/.claude/panel.json"
start
wait_for 'Claude (is )?OFF' 5; ok "session starts with only the shell" "$?"

echo "== project off (enabled=false) -> no session"
echo '{"projects":{"p1":{"enabled":false}}}' > "$T/.claude/panel.json"
start
tmux has-session -t '=claude-p1' 2>/dev/null; ok "does not create the session" "$([ $? -ne 0 ] && echo 0 || echo 1)"

echo "== new workspace asks 'trust this folder' -> the supervisor accepts it"
cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
echo "Quick safety check: Is this project you created or one you trust?"
echo " ❯ No, exit"
echo "   Yes, I trust this folder"
echo "Enter to confirm · Esc to cancel"
trusted=0
while IFS= read -rsn1 k; do
  if [ "$trusted" = "0" ]; then
    # Down (arrows arrive as the sequence ESC [ B) moves the cursor to "Yes"; any other key
    # before that is ignored to simulate the menu (the fake only understands this exact sequence)
    if [ "$k" = $'\x1b' ]; then IFS= read -rsn2 rest; [ "$rest" = "[B" ] && trusted=1; fi
  elif [ -z "$k" ]; then   # Enter with the cursor already on "Yes" -> confirms
    echo "? for shortcuts"
    trusted=2
  fi
done
EOF
chmod +x "$T/bin/claude"
rm -f "$T/.claude/panel.json"
echo '{"ok":1}' > "$T/.claude/.credentials.json"
start
wait_for '\? for shortcuts' 15; ok "accepts 'trust this folder' by itself and the TUI opens" "$?" "$(screen | tail -6 | tr '\n' '|')"

echo "== paused: does not open Claude until the flag is removed"
cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo "? for shortcuts"; cat
EOF
chmod +x "$T/bin/claude"
mkdir -p "$T/.claude/run"; echo manual > "$T/.claude/run/claude-p1.paused"
start
wait_for 'Claude paused' 8; ok "shows 'paused' instead of opening Claude" "$?" "$(screen | tail -4 | tr '\n' '|')"
screen | grep -q '? for shortcuts'; ok "Claude did not open while paused" "$([ $? -ne 0 ] && echo 0 || echo 1)"
rm -f "$T/.claude/run/claude-p1.paused"
wait_for '\? for shortcuts' 12; ok "flag removed -> Claude opens" "$?"

echo "== crash-loop: stops reopening and warns"
cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
exit 1
EOF
chmod +x "$T/bin/claude"
: > "$T/.claude/run/alerts.jsonl"
MAX_FAST_FAILS=2 start
wait_for 'too fast' 20; ok "drops to the shell after fast failures in a row" "$?" "$(screen | tail -4 | tr '\n' '|')"
grep -q '"kind":"crash-loop"' "$T/.claude/run/alerts.jsonl"; ok "writes a crash-loop alert" "$?"

echo "== Claude account per project: CLAUDE_CONFIG_DIR of the account, shared history"
# fake claude that shows which config dir / token it got and whether it sees the shared history
cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
c="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
echo "CFG=${CLAUDE_CONFIG_DIR:-none} TOK=${CLAUDE_CODE_OAUTH_TOKEN:-none} ARGS=${*:-none}"
echo "HIST=$(ls "$c/projects/$(printf '%s' "$PWD" | tr -c 'A-Za-z0-9' '-')" 2>/dev/null | tr '\n' ',')"
echo "? for shortcuts"; cat
EOF
chmod +x "$T/bin/claude"
rm -f "$T/.claude/run/"*.paused "$T/.claude/panel.json"
AD="$T/.claude-accounts/work-1a2b"
mkdir -p "$AD" "$T/.claude/skills"
echo '{"theme":"dark"}' > "$T/.claude/settings.json"
# a conversation made with the DEFAULT account, in the folder of p1
CD="$T/.claude/projects/$(printf '%s' "$T/projects/p1" | tr -c 'A-Za-z0-9' '-')"
mkdir -p "$CD"; echo '{}' > "$CD/conv-default-111.jsonl"
echo '{"projects":{"p1":{"account":"work-1a2b","sessionMode":"continue","autoRemote":false}}}' > "$T/.claude/panel.json"
start
wait_for "CFG=$AD " 12; ok "Claude starts with CLAUDE_CONFIG_DIR of the project's account" "$?" "$(screen | tail -5 | tr '\n' '|')"
screen | grep -q 'HIST=conv-default-111.jsonl'; ok "the account sees the conversation made with the default account (shared history)" "$?" "$(screen | tail -5 | tr '\n' '|')"
screen | grep -q 'ARGS=--continue'; ok "sessionMode continue -> --continue the same conversation on the new account" "$?"
[ -L "$AD/projects" ] && [ "$(readlink -f "$AD/projects")" = "$(readlink -f "$T/.claude/projects")" ]; ok "projects/ of the account is a symlink to ~/.claude/projects" "$?"
[ -L "$AD/settings.json" ] && [ -L "$AD/skills" ] && [ -L "$AD/plugins" ]; ok "settings.json, skills/, plugins/ shared by symlink" "$?"
[ ! -e "$AD/.credentials.json" ]; ok "credentials are not shared" "$?"
[ "$(tmux show-environment -t '=claude-p1' CLAUDE_CONFIG_DIR 2>/dev/null)" = "CLAUDE_CONFIG_DIR=$AD" ]; ok "tmux session environment has the account dir (shells/windows too)" "$?"
grep -q '(account work-1a2b)' "$T/.claude/logs/sessions.log"; ok "sessions.log says which account started" "$?"

echo "== account: long-lived token exported; login checked in the account dir"
printf 'sk-ant-oat01-TESTTOKEN\n' > "$AD/.oauth-token"; chmod 600 "$AD/.oauth-token"
start
wait_for 'TOK=sk-ant-oat01-TESTTOKEN ' 12; ok "pasted token goes as CLAUDE_CODE_OAUTH_TOKEN" "$?" "$(screen | tail -5 | tr '\n' '|')"
grep -q 'TESTTOKEN' "$T/.claude/logs/sessions.log"; ok "token never in sessions.log" "$([ $? -ne 0 ] && echo 0 || echo 1)"
( . "$HERE/devbox-lib.sh"; is_logged_in "$AD" ); ok "is_logged_in(account dir) true with the token" "$?"
rm -f "$AD/.oauth-token" "$T/.claude/.credentials.json"
( . "$HERE/devbox-lib.sh"; is_logged_in "$AD" ); ok "is_logged_in(account dir) false without login" "$([ $? -ne 0 ] && echo 0 || echo 1)"
echo '{"ok":1}' > "$AD/.credentials.json"
( . "$HERE/devbox-lib.sh"; is_logged_in "$AD" && ! is_logged_in "" ); ok "login of the account does not count as the default one (and vice versa)" "$?"

echo "== removed account -> default account (no CLAUDE_CONFIG_DIR)"
echo '{"projects":{"p1":{"account":"gone-0000","autoRemote":false}}}' > "$T/.claude/panel.json"
start
wait_for 'CFG=none ' 12; ok "unknown account -> default (no CLAUDE_CONFIG_DIR)" "$?" "$(screen | tail -5 | tr '\n' '|')"
grep -q "account: 'gone-0000' does not exist" "$T/.claude/logs/sessions.log"; ok "logs the missing account" "$?"
echo '{"projects":{"p1":{"account":"../../etc","autoRemote":false}}}' > "$T/.claude/panel.json"
start
wait_for 'CFG=none ' 12; ok "invalid account id in panel.json -> default" "$?"
rm -rf "$T/.claude-accounts" "$T/.claude/panel.json" "$CD"
echo '{"ok":1}' > "$T/.claude/.credentials.json"

echo "== a deleted project does not come back"
tmux kill-server >/dev/null 2>&1
bash "$HERE/claude-session.sh" ghost </dev/null >/dev/null 2>&1
[ ! -d "$T/projects/ghost" ]; ok "deleted folder is not recreated" $?
tmux has-session -t '=claude-ghost' 2>/dev/null; [ $? -ne 0 ]; ok "session of the deleted project does not start" $?
echo "== a git worktree Claude makes next to a project is not a project ('app.gate-wt' bug)"
tmux kill-server >/dev/null 2>&1
mkdir -p "$T/projects/app" "$T/projects/app.gate-wt" "$T/projects/wt2"
echo "gitdir: $T/projects/app/.git/worktrees/wt2" > "$T/projects/wt2/.git"
bash "$HERE/claude-session.sh" --all </dev/null >/dev/null 2>&1
tmux has-session -t '=claude-app_gate-wt' 2>/dev/null; [ $? -ne 0 ]; ok "'<project>.<x>' folder gets no session" $?
tmux has-session -t '=claude-wt2' 2>/dev/null; [ $? -ne 0 ]; ok "git worktree (.git is a file) gets no session" $?
tmux kill-server >/dev/null 2>&1
rm -rf "$T/projects/app" "$T/projects/app.gate-wt" "$T/projects/wt2"
echo
echo "$pass PASS, $fail FAIL"
[ "$fail" = "0" ]
