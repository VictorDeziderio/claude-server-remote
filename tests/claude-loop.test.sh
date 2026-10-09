#!/usr/bin/env bash
# Testes do supervisor (claude-loop.sh) + claude-session.sh com um `claude` FALSO, num tmux e
# HOME temporarios — nada real e tocado. Uso: bash tests/claude-loop.test.sh (precisa de tmux).
set -uo pipefail
# de dentro de um tmux, $TMUX vence TMUX_TMPDIR e o `tmux kill-server` abaixo mataria o servidor REAL
unset TMUX TMUX_PANE
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
export HOME="$T" TMUX_TMPDIR="$T" CLAUDE_AUTOCMD_DELAY=1
# PROJECTS_DIR/PANEL_CONFIG tambem isolados: devbox-lib.sh so usa $HOME como default se essas
# vierem VAZIAS do ambiente -- rodando este teste de dentro do dev-box real (onde start.sh ja
# exportou as de verdade), elas vazam pro teste e ele acaba lendo/criando sessao no projeto
# REAL em vez do temporario (achado 2026-10-09, rodando os testes de dentro do proprio dev-box).
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

# `claude` falso: prompt pronto; /remote-control abre o dialogo de CONFIRMACAO do Claude Code
# 2.1.28x ("❯ 1. Enable Remote Control / 2. Never mind"). Enter confirma, Esc cancela.
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
grep -q 'sem login' "$T/.claude/logs/sessions.log" 2>/dev/null; ok "registra o motivo em sessions.log" "$?"

echo "== Claude OFF no panel.json -> shell"
echo '{"projects":{"p1":{"autoStartClaude":false}}}' > "$T/.claude/panel.json"
start
wait_for 'Claude DESLIGADO' 5; ok "sessao sobe so com o shell" "$?"

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
    # Down (setas chegam como sequencia ESC [ B) move o cursor p/ "Yes"; qualquer outra tecla
    # antes disso e' ignorada pra simular o menu (o "fake" so entende essa sequencia exata)
    if [ "$k" = $'\x1b' ]; then IFS= read -rsn2 rest; [ "$rest" = "[B" ] && trusted=1; fi
  elif [ -z "$k" ]; then   # Enter com o cursor ja em "Yes" -> confirma
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

echo
echo "$pass PASS, $fail FAIL"
[ "$fail" = "0" ]
