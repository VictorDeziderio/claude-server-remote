#!/usr/bin/env bash
# Supervisor do Claude (rodado pela sessao tmux "claude"). Roda o Claude em loop:
# se ele sair (exit/crash), reabre em 3s. A CADA (re)inicio, RELIGA o remote-control
# apos o delay (se logado) — porque `claude` sobe uma conversa nova e NAO reconecta o
# remote-control sozinho. Assim o remote-control volta no boot, no respawn e quando o
# watchdog recria a sessao. Para cair no shell de proposito: Ctrl-C na janela de 3s.
#
# Args:  $1 = comando a enviar (ex.: "/remote-control easypanel meu-servidor"; vazio desativa)
#        $2 = segundos de espera antes de enviar (Claude carregar)
FULL_AUTOCMD="${1:-}"
DELAY="${2:-15}"

# verdadeiro se o Claude ja estiver logado (/login feito)
is_logged_in() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -s "$HOME/.claude/.credentials.json" ] && return 0
  grep -qE '"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"' "$HOME/.claude.json" 2>/dev/null && return 0
  return 1
}

while true; do
  # agenda o envio do remote-control para depois que o Claude carregar.
  # roda em paralelo ao `claude` abaixo; envia as teclas para o proprio pane.
  if [ -n "$FULL_AUTOCMD" ]; then
    ( sleep "$DELAY"
      cur=$(tmux display-message -p -t claude '#{pane_current_command}' 2>/dev/null || true)
      if is_logged_in && { [ "$cur" = node ] || [ "$cur" = claude ]; }; then
        tmux send-keys -t claude "$FULL_AUTOCMD" Enter
      fi
    ) &
  fi

  claude

  echo "[claude saiu — reabrindo em 3s | Ctrl-C cancela]"
  sleep 3
done
