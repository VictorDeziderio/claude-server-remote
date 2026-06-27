#!/usr/bin/env bash
# (Re)cria a sessao tmux de UM projeto: claude-<nome>. Cada projeto tem sua propria
# sessao, entao o Claude roda em paralelo por projeto (modelo multi-tmux).
#
# A sessao roda na pasta do projeto (PROJECTS_DIR/<nome>) e honra o panel.json:
#   - autoStartClaude=true  -> sobe o Claude (supervisor claude-loop.sh)
#                     false -> deixa so um shell na pasta (sem Claude)
#   - autoRemote=true       -> religa o /remote-control automaticamente (se logado)
#                    false  -> nao envia o remote-control
# O comando do remote-control usa o NOME DO PROJETO: "/remote-control <nome>"
# (cada projeto aparece com seu proprio nome no controle remoto).
#
# Roda como o usuario ubuntu (HOME=/root). Idempotente: nao mexe se a sessao ja existe.
#
# Uso:  claude-session.sh <nome-do-projeto>
# Env:  PROJECTS_DIR (default /root/projects), PANEL_CONFIG (default /root/.claude/panel.json),
#       CLAUDE_AUTOCMD_DELAY (default 15), REMOTE_CONTROL_NAME (override opcional do nome do remote)
set -uo pipefail

H="${HOME:-/root}"
PROJECTS_DIR="${PROJECTS_DIR:-$H/projects}"
CFG="${PANEL_CONFIG:-$H/.claude/panel.json}"
DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"

name="${1:?uso: claude-session.sh <projeto>}"
proj="$PROJECTS_DIR/$name"
mkdir -p "$H/.claude" "$proj"

# nome da sessao tmux: claude-<nome sanitizado> (tmux nao aceita '.'/':' em nomes).
# A mesma sanitizacao e feita no server.js (sessionName) -> tem de bater.
sess="claude-$(printf '%s' "$name" | tr -c 'A-Za-z0-9_-' '_')"

# comando do remote-control deste projeto = nome do projeto (ou REMOTE_CONTROL_NAME se forcado)
remote_name="${REMOTE_CONTROL_NAME:-$name}"
FULL_AUTOCMD="/remote-control ${remote_name}"

# Le uma flag booleana do projeto no panel.json (default true). Usa node (sempre presente).
read_flag() {  # $1 = chave (autoStartClaude|autoRemote) -> imprime "true"|"false"
  node -e '
    const fs = require("fs");
    const [,, file, proj, key] = process.argv;
    let c = {}; try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const d = (c && c.defaults) || {};
    const p = (c && c.projects && c.projects[proj]) || {};
    const v = (key in p) ? p[key] : (key in d ? d[key] : true);
    process.stdout.write(v === false ? "false" : "true");
  ' "$CFG" "$name" "$1" 2>/dev/null || printf 'true'
}
START_CLAUDE="$(read_flag autoStartClaude)"
AUTO_REMOTE="$(read_flag autoRemote)"

# autoRemote=false -> nao envia o remote-control nesta sessao
[ "$AUTO_REMOTE" = "true" ] || FULL_AUTOCMD=""

# ja existe -> nada a fazer (idempotente, usado pelo watchdog)
tmux has-session -t "$sess" 2>/dev/null && exit 0

tmux new-session -d -s "$sess" -c "$proj"
if [ "$START_CLAUDE" = "true" ]; then
  # supervisor: roda o Claude em loop + religa o remote-control (se AUTO_REMOTE e logado)
  tmux send-keys -t "$sess" "bash /usr/local/bin/claude-loop.sh '$sess' '$FULL_AUTOCMD' '$DELAY'" Enter
else
  # auto-start do Claude DESLIGADO no painel: deixa so o shell na pasta
  tmux send-keys -t "$sess" "clear; echo '[dev-box] projeto \"$name\": auto-start do Claude DESLIGADO (panel.json). Rode  claude  quando quiser.'" Enter
fi
