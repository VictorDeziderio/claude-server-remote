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
wait_for() {  # $1 = regex, $2 = segundos
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
      if [ -z "$k" ]; then echo "Remote Control active: https://claude.ai/code/session_TESTE123"
      else echo "remote cancelado"; fi ;;
  esac
done
EOF
chmod +x "$T/bin/claude"

echo "== remote-control com o dialogo de confirmacao"
echo '{"ok":1}' > "$T/.claude/.credentials.json"   # "logado"
start
wait_for 'claude\.ai/code/session_TESTE123' 25; r=$?
ok "o supervisor confirma 'Enable Remote Control' e o remote ativa" "$r" "$(screen | tail -5 | tr '\n' '|')"
screen | grep -q 'remote cancelado'; ok "nao cancelou o dialogo (Esc = Never mind)" "$([ $? -ne 0 ] && echo 0 || echo 1)"

echo "== sem login, o remote nao e enviado"
rm -f "$T/.claude/.credentials.json"
start
sleep 4
screen | grep -q '/remote-control\|Remote Control'; ok "sem login nao digita /remote-control" "$([ $? -ne 0 ] && echo 0 || echo 1)"
grep -q 'not logged in' "$T/.claude/logs/sessions.log" 2>/dev/null; ok "registra o motivo em sessions.log" "$?"

echo "== Claude OFF no panel.json -> shell"
echo '{"projects":{"p1":{"autoStartClaude":false}}}' > "$T/.claude/panel.json"
start
wait_for 'Claude (is )?OFF' 5; ok "sessao sobe so com o shell" "$?"

echo "== projeto desligado (enabled=false) -> sem sessao"
echo '{"projects":{"p1":{"enabled":false}}}' > "$T/.claude/panel.json"
start
tmux has-session -t '=claude-p1' 2>/dev/null; ok "nao cria a sessao" "$([ $? -ne 0 ] && echo 0 || echo 1)"

echo "== workspace novo pede 'trust this folder' -> supervisor aceita sozinho"
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
wait_for '\? for shortcuts' 15; ok "aceita 'trust this folder' sozinho e a TUI libera" "$?" "$(screen | tail -6 | tr '\n' '|')"

echo "== pausado: nao abre o Claude ate tirar o flag"
cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
echo "? for shortcuts"; cat
EOF
chmod +x "$T/bin/claude"
mkdir -p "$T/.claude/run"; echo manual > "$T/.claude/run/claude-p1.paused"
start
wait_for 'Claude paused' 8; ok "mostra 'pausado' em vez de abrir o Claude" "$?" "$(screen | tail -4 | tr '\n' '|')"
screen | grep -q '? for shortcuts'; ok "Claude nao abriu enquanto pausado" "$([ $? -ne 0 ] && echo 0 || echo 1)"
rm -f "$T/.claude/run/claude-p1.paused"
wait_for '\? for shortcuts' 12; ok "tirou o flag -> Claude abre" "$?"

echo "== crash-loop: para de reabrir e avisa"
cat > "$T/bin/claude" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
exit 1
EOF
chmod +x "$T/bin/claude"
: > "$T/.claude/run/alerts.jsonl"
MAX_FAST_FAILS=2 start
wait_for 'too fast' 20; ok "cai no shell apos falhas rapidas seguidas" "$?" "$(screen | tail -4 | tr '\n' '|')"
grep -q '"kind":"crash-loop"' "$T/.claude/run/alerts.jsonl"; ok "grava alerta crash-loop" "$?"

echo "== projeto apagado nao renasce (bug do projeto \"codigo\")"
tmux kill-server >/dev/null 2>&1
bash "$HERE/claude-session.sh" fantasma </dev/null >/dev/null 2>&1
[ ! -d "$T/projects/fantasma" ]; ok "pasta apagada nao e recriada" $?
tmux has-session -t '=claude-fantasma' 2>/dev/null; [ $? -ne 0 ]; ok "sessao do projeto apagado nao sobe" $?
echo "== worktree do Claude ao lado do projeto nao vira projeto (bug do 'app.gate-wt')"
tmux kill-server >/dev/null 2>&1
mkdir -p "$T/projects/app" "$T/projects/app.gate-wt" "$T/projects/wt2"
echo "gitdir: $T/projects/app/.git/worktrees/wt2" > "$T/projects/wt2/.git"
bash "$HERE/claude-session.sh" --all </dev/null >/dev/null 2>&1
tmux has-session -t '=claude-app_gate-wt' 2>/dev/null; [ $? -ne 0 ]; ok "pasta <projeto>.<x> nao ganha sessao" $?
tmux has-session -t '=claude-wt2' 2>/dev/null; [ $? -ne 0 ]; ok "worktree git (.git arquivo) nao ganha sessao" $?
tmux kill-server >/dev/null 2>&1
rm -rf "$T/projects/app" "$T/projects/app.gate-wt" "$T/projects/wt2"
echo
echo "$pass PASS, $fail FAIL"
[ "$fail" = "0" ]
