#!/usr/bin/env bash
# Supervisor do Claude para UMA sessao tmux (modelo multi-tmux: 1 sessao por projeto).
# Roda o Claude em loop: se ele sair (exit/crash), reabre em 3s. A CADA (re)inicio,
# RELIGA o remote-control apos o delay (se logado) — porque `claude` sobe uma conversa
# nova e NAO reconecta o remote-control sozinho. Para cair no shell: Ctrl-C na janela de 3s.
#
# Mantem um FLAG FILE por sessao (~/.claude/run/<sessao>.running) enquanto o Claude esta
# de fato rodando. O painel le esse flag em vez de adivinhar pelo pane_current_command
# (que mostra "bash"/o supervisor e dava falso-negativo de "parado").
#
# Args:  $1 = nome da sessao tmux (ex.: claude-pilot)
#        $2 = comando do remote-control (ex.: "/remote-control pilot"; vazio desativa)
#        $3 = segundos de espera antes de enviar o remote-control (Claude carregar)
set -uo pipefail
SESS="${1:?uso: claude-loop.sh <sessao> [remote_cmd] [delay]}"
FULL_AUTOCMD="${2:-}"
DELAY="${3:-15}"

H="${HOME:-/root}"
RUN_DIR="$H/.claude/run"
RUN_FLAG="$RUN_DIR/$SESS.running"
mkdir -p "$RUN_DIR"

# verdadeiro se o Claude ja estiver logado (/login feito)
is_logged_in() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -s "$H/.claude/.credentials.json" ] && return 0
  grep -qE '"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"' "$H/.claude.json" 2>/dev/null && return 0
  return 1
}

# garante que o flag suma se o supervisor for encerrado (kill-session, etc.)
cleanup() { rm -f "$RUN_FLAG"; }
trap cleanup EXIT INT TERM

while true; do
  # agenda o envio do remote-control para depois que o Claude carregar (em paralelo ao `claude`).
  if [ -n "$FULL_AUTOCMD" ]; then
    ( sleep "$DELAY"
      if is_logged_in; then
        # texto e Enter SEPARADOS (o Claude usa bracketed paste e engole o Enter junto)
        tmux send-keys -t "$SESS" "$FULL_AUTOCMD"
        sleep 1
        tmux send-keys -t "$SESS" Enter
      fi
    ) &
  fi

  : > "$RUN_FLAG"     # marca: Claude rodando
  claude
  rm -f "$RUN_FLAG"   # marca: Claude parado (caiu no shell ou crashou)

  echo "[claude saiu — reabrindo em 3s | Ctrl-C cancela]"
  sleep 3
done
