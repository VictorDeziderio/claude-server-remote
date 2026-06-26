#!/usr/bin/env bash
# Entrypoint do dev-box claude (prepara como root, depois roda como usuario nao-root):
#  - settings.json com bypassPermissions (permite tudo)
#  - sessao tmux "claude" persistente, iniciada DENTRO de $PROJECT_FOLDER, rodando o Claude
#  - apos o Claude carregar, envia automaticamente o comando $CLAUDE_AUTOCMD
#  - sobe o code-server (IDE) se IDE_ENABLED=true
#
# Variaveis (campo Environment do EasyPanel):
#   IDE_ENABLED          true|false  -> habilita/desabilita o IDE web (default: true)
#   IDE_PASSWORD         <senha>     -> senha do IDE (code-server)
#   PROJECT_FOLDER       projects    -> pasta (dentro de /root) onde o Claude inicia
#   REMOTE_CONTROL_NAME  meu-servidor      -> nome anexado ao CLAUDE_AUTOCMD (ex.: .../easypanel meu-servidor)
#   CLAUDE_AUTOCMD       /remote-control easypanel -> comando enviado ao Claude no start ("" desativa)
#   CLAUDE_AUTOCMD_DELAY 15          -> segundos de espera antes de enviar o comando
set -euo pipefail

U=ubuntu
H=/root                                  # home do usuario ubuntu = volume persistente
PROJECT_FOLDER="${PROJECT_FOLDER:-projects}"
PROJ="$H/$PROJECT_FOLDER"
REMOTE_CONTROL_NAME="${REMOTE_CONTROL_NAME:-}"
CLAUDE_AUTOCMD="${CLAUDE_AUTOCMD:-/remote-control easypanel}"
CLAUDE_AUTOCMD_DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"
# comando final = autocmd + nome do remote-control (se definido)
#   ex.: CLAUDE_AUTOCMD="/remote-control easypanel" + REMOTE_CONTROL_NAME=meu-servidor
#        -> "/remote-control easypanel meu-servidor"
FULL_AUTOCMD="${CLAUDE_AUTOCMD}${REMOTE_CONTROL_NAME:+ ${REMOTE_CONTROL_NAME}}"

# settings do Claude: permite tudo (so cria se nao existir)
mkdir -p "$H/.claude" "$PROJ"
if [ ! -f "$H/.claude/settings.json" ]; then
  cat > "$H/.claude/settings.json" <<'JSON'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
JSON
fi

# ownership do volume p/ o usuario nao-root
chown -R "$U:$U" "$H" 2>/dev/null || true

# helper: roda como ubuntu, com HOME no volume
as_user() { gosu "$U" env HOME="$H" USER="$U" "$@"; }

# Sessao tmux "claude" iniciada na pasta de projetos, rodando o Claude Code
if ! as_user tmux has-session -t claude 2>/dev/null; then
  as_user tmux new-session -d -s claude -c "$PROJ"
  as_user tmux send-keys -t claude 'claude' Enter
  # apos o Claude carregar, envia o comando automatico (ex.: /remote-control easypanel meu-servidor)
  # SO envia se o Claude estiver realmente ativo na sessao (pane rodando node/claude).
  # Se o Claude nao estiver rodando (caiu, shell normal, etc.), deixa normal e nao envia.
  if [ -n "$FULL_AUTOCMD" ]; then
    ( sleep "$CLAUDE_AUTOCMD_DELAY"
      cur=$(as_user tmux display-message -p -t claude '#{pane_current_command}' 2>/dev/null || true)
      case "$cur" in
        node|claude) as_user tmux send-keys -t claude "$FULL_AUTOCMD" Enter ;;
        *) : ;;  # Claude nao esta ativo -> nao dispara o remote-control
      esac
    ) &
  fi
fi

# IDE (VS Code web)
if [ "${IDE_ENABLED:-true}" = "true" ]; then
  echo ">> IDE on (8080) | projeto: $PROJ | autocmd: ${CLAUDE_AUTOCMD:-<nenhum>}"
  # code-server le a var PASSWORD; mapeamos IDE_PASSWORD -> PASSWORD
  exec gosu "$U" env HOME="$H" USER="$U" PASSWORD="${IDE_PASSWORD:-}" \
    code-server --bind-addr 0.0.0.0:8080 --auth password "$PROJ"
else
  echo ">> IDE off. Console + 'tmux attach -t claude'."
  exec sleep infinity
fi
