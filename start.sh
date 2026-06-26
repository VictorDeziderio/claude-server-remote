#!/usr/bin/env bash
# Entrypoint do dev-box claude (roda como root só p/ preparar, depois cai p/ usuario nao-root):
#  - o Claude Code recusa bypass de permissoes como root, entao tudo roda como "ubuntu"
#  - cria automaticamente ~/.claude/settings.json com bypassPermissions (permite tudo, sem prompt)
#  - cria/garante a sessao tmux "claude" persistente rodando o Claude Code
#  - sobe o code-server (IDE) se IDE_ENABLED=true (senha = $PASSWORD)
#
# Variaveis (campo Environment do EasyPanel):
#   IDE_ENABLED  true|false  -> habilita/desabilita o IDE web (default: true)
#   PASSWORD     <senha>     -> senha de acesso ao IDE (code-server)
set -euo pipefail

U=ubuntu
H=/root   # home do usuario ubuntu = o volume persistente

# settings do Claude: permite tudo automaticamente (equiv. --dangerously-skip-permissions).
# Criado so se nao existir, para respeitar customizacoes suas.
mkdir -p "$H/.claude"
if [ ! -f "$H/.claude/settings.json" ]; then
  cat > "$H/.claude/settings.json" <<'JSON'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
JSON
fi

# garante que o usuario nao-root e dono do volume (montado em /root)
chown -R "$U:$U" "$H" 2>/dev/null || true

# helper: roda como ubuntu, com HOME no volume
as_user() { gosu "$U" env HOME="$H" USER="$U" "$@"; }

# Sessao tmux persistente com o Claude Code (como usuario nao-root)
if ! as_user tmux has-session -t claude 2>/dev/null; then
  as_user tmux new-session -d -s claude -c "$H"
  # lanca o claude dentro da sessao (1a vez pede login; depois persiste em ~/.claude)
  as_user tmux send-keys -t claude 'claude' Enter
fi

# IDE (VS Code web) — habilita/desabilita via IDE_ENABLED
if [ "${IDE_ENABLED:-true}" = "true" ]; then
  echo ">> IDE habilitado (code-server na porta 8080), usuario: $U"
  exec gosu "$U" env HOME="$H" USER="$U" \
    code-server --bind-addr 0.0.0.0:8080 --auth password "$H"
else
  echo ">> IDE desabilitado (IDE_ENABLED=false). Use o Console + 'tmux attach -t claude'."
  exec sleep infinity
fi
