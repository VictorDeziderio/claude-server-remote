#!/usr/bin/env bash
# (Re)cria a sessao tmux "claude" na PASTA ATIVA, respeitando a config do projeto.
#
# Pasta ativa = conteudo de /root/.claude/active-project (1a linha), se existir;
# senao o default /root/$PROJECT_FOLDER. Esse arquivo e a fonte da verdade: tanto o
# start.sh (boot + watchdog) quanto o painel usam este script -> a sessao sempre sobe
# na mesma pasta. O painel troca de projeto reescrevendo o arquivo e rodando isto.
#
# DINAMICO: le /root/.claude/panel.json e decide, POR PROJETO:
#   - autoStartClaude=true  -> sobe o Claude (supervisor claude-loop.sh)
#                     false -> deixa so um shell na pasta (sem Claude)
#   - autoRemote=true       -> religa o /remote-control automaticamente (se logado)
#                    false  -> nao envia o remote-control
# Sem entrada no panel.json -> usa "defaults" -> ou true/true (compat. com o legado).
#
# Roda como o usuario ubuntu (HOME=/root). Idempotente: nao mexe se a sessao ja existe.
#
# Args opcionais (senao usa o env / defaults):
#   $1 = FULL_AUTOCMD  (comando do remote-control; vazio desativa globalmente)
#   $2 = DELAY         (segundos antes de enviar o remote-control)
set -uo pipefail

H="${HOME:-/root}"
DEFAULT_PROJ="$H/${PROJECT_FOLDER:-projects}"
ACTIVE_FILE="$H/.claude/active-project"
CFG="${PANEL_CONFIG:-$H/.claude/panel.json}"
FULL_AUTOCMD="${1-${FULL_AUTOCMD:-}}"
DELAY="${2-${CLAUDE_AUTOCMD_DELAY:-15}}"

# pasta ativa: do arquivo (se tiver conteudo), senao o default
proj="$DEFAULT_PROJ"
if [ -s "$ACTIVE_FILE" ]; then
  p="$(head -n1 "$ACTIVE_FILE")"
  [ -n "$p" ] && proj="$p"
fi
mkdir -p "$H/.claude" "$proj"
projname="$(basename "$proj")"

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
  ' "$CFG" "$projname" "$1" 2>/dev/null || printf 'true'
}
START_CLAUDE="$(read_flag autoStartClaude)"
AUTO_REMOTE="$(read_flag autoRemote)"

# autoRemote=false -> nao envia o remote-control (zera o autocmd so p/ esta sessao)
[ "$AUTO_REMOTE" = "true" ] || FULL_AUTOCMD=""

# ja existe -> nada a fazer (idempotente, usado pelo watchdog)
tmux has-session -t claude 2>/dev/null && exit 0

tmux new-session -d -s claude -c "$proj"
if [ "$START_CLAUDE" = "true" ]; then
  # supervisor: roda o Claude em loop + religa o remote-control (se AUTO_REMOTE e logado)
  tmux send-keys -t claude "bash /usr/local/bin/claude-loop.sh '$FULL_AUTOCMD' '$DELAY'" Enter
else
  # auto-start do Claude DESLIGADO no painel: deixa so o shell na pasta
  tmux send-keys -t claude "clear; echo '[dev-box] projeto \"$projname\": auto-start do Claude DESLIGADO (panel.json). Rode  claude  quando quiser.'" Enter
fi
