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

# verdadeiro se o Claude ja estiver logado (/login feito) — via API key ou credenciais salvas
is_logged_in() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -s "$H/.claude/.credentials.json" ] && return 0
  grep -qE '"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"' "$H/.claude.json" 2>/dev/null && return 0
  return 1
}

# Sessao tmux "claude" iniciada na pasta de projetos, rodando o Claude Code
if ! as_user tmux has-session -t claude 2>/dev/null; then
  as_user tmux new-session -d -s claude -c "$PROJ"
  as_user tmux send-keys -t claude 'claude' Enter
  # apos o Claude carregar, envia o comando automatico (ex.: /remote-control easypanel meu-servidor).
  # SO dispara se: (1) /login feito  E  (2) Claude ativo  E  (3) ainda nao foi estabelecido antes.
  # O marcador evita DUPLICAR o remote-control (o Claude ja restaura o anterior do volume no start).
  # Para forcar de novo: apague /root/.claude/.remote-control-established (ou rode /remote-control manual).
  RC_MARKER="$H/.claude/.remote-control-established"
  if [ -n "$FULL_AUTOCMD" ] && [ ! -f "$RC_MARKER" ]; then
    ( sleep "$CLAUDE_AUTOCMD_DELAY"
      cur=$(as_user tmux display-message -p -t claude '#{pane_current_command}' 2>/dev/null || true)
      if is_logged_in && { [ "$cur" = node ] || [ "$cur" = claude ]; }; then
        as_user tmux send-keys -t claude "$FULL_AUTOCMD" Enter
        touch "$RC_MARKER" && chown "$U:$U" "$RC_MARKER" 2>/dev/null || true
      fi
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
