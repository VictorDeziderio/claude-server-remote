#!/usr/bin/env bash
# Entrypoint do dev-box claude:
#  - cria/garante uma sessao tmux "claude" persistente rodando o Claude Code
#    (sobrevive a desconexao do terminal/IDE; so morre se o container reiniciar)
#  - sobe o code-server (IDE) se IDE_ENABLED=true (senha = $PASSWORD)
#
# Variaveis (defina no campo Environment do EasyPanel):
#   IDE_ENABLED   true|false  -> habilita/desabilita o IDE web (default: true)
#   PASSWORD      <senha>     -> senha de acesso ao IDE (code-server)
set -euo pipefail

# Sessao tmux persistente com o Claude Code
if ! tmux has-session -t claude 2>/dev/null; then
  tmux new-session -d -s claude -c /root
  # lanca o claude dentro da sessao (1a vez pede login; depois persiste em ~/.claude)
  tmux send-keys -t claude 'claude' Enter
fi

# IDE (VS Code web) — habilita/desabilita via IDE_ENABLED
if [ "${IDE_ENABLED:-true}" = "true" ]; then
  echo ">> IDE habilitado (code-server na porta 8080)"
  exec code-server --bind-addr 0.0.0.0:8080 --auth password /root
else
  echo ">> IDE desabilitado (IDE_ENABLED=false). Container vivo; use o Console + 'tmux attach -t claude'."
  exec sleep infinity
fi
