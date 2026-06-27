#!/usr/bin/env bash
# (Re)cria a sessao tmux "claude" na PASTA ATIVA, rodando o supervisor (claude-loop.sh).
#
# Pasta ativa = conteudo de /root/.claude/active-project (1a linha), se existir;
# senao o default /root/$PROJECT_FOLDER. Esse arquivo e a fonte da verdade: tanto o
# start.sh (boot + watchdog) quanto o painel usam este script -> a sessao sempre sobe
# na mesma pasta. O painel troca de projeto reescrevendo o arquivo e rodando isto.
#
# Roda como o usuario ubuntu (HOME=/root). Idempotente: nao mexe se a sessao ja existe.
#
# Args opcionais (senao usa o env / defaults):
#   $1 = FULL_AUTOCMD  (comando do remote-control; vazio desativa)
#   $2 = DELAY         (segundos antes de enviar o remote-control)
set -uo pipefail

H="${HOME:-/root}"
DEFAULT_PROJ="$H/${PROJECT_FOLDER:-projects}"
ACTIVE_FILE="$H/.claude/active-project"
FULL_AUTOCMD="${1-${FULL_AUTOCMD:-}}"
DELAY="${2-${CLAUDE_AUTOCMD_DELAY:-15}}"

# pasta ativa: do arquivo (se tiver conteudo), senao o default
proj="$DEFAULT_PROJ"
if [ -s "$ACTIVE_FILE" ]; then
  p="$(head -n1 "$ACTIVE_FILE")"
  [ -n "$p" ] && proj="$p"
fi
mkdir -p "$H/.claude" "$proj"

# ja existe -> nada a fazer (idempotente, usado pelo watchdog)
tmux has-session -t claude 2>/dev/null && exit 0

tmux new-session -d -s claude -c "$proj"
tmux send-keys -t claude "bash /usr/local/bin/claude-loop.sh '$FULL_AUTOCMD' '$DELAY'" Enter
