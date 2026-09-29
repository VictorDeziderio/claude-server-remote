#!/usr/bin/env bash
# Garante a sessao tmux de um projeto (claude-<nome>) conforme o panel.json — modelo multi-tmux.
#
#   enabled=false          -> projeto DESLIGADO: NAO cria sessao (boot/watchdog respeitam)
#   autoStartClaude=true   -> a sessao roda o supervisor claude-loop.sh (Claude em loop)
#                  =false  -> a sessao e so um shell na pasta do projeto
#   autoRemote / initLine  -> lidos pelo claude-loop.sh a CADA inicio do Claude (mudou no
#                             painel -> vale no proximo (re)inicio, sem recriar a sessao)
#
# Idempotente: nao mexe em sessao que ja existe. Roda como o usuario ubuntu (HOME=/root).
#
# Uso:  claude-session.sh <projeto>
#       claude-session.sh --all        # todos os projetos LIGADOS (boot + watchdog); se nao
#                                      # houver nenhum projeto, cria o default ($PROJECT_FOLDER)
set -uo pipefail

LIB="${DEVBOX_LIB:-/usr/local/lib/devbox/lib.sh}"
# shellcheck source=devbox-lib.sh
. "$LIB"
LOOP="${CLAUDE_LOOP:-/usr/local/bin/claude-loop.sh}"

ensure_one() {  # $1 = projeto
  local name="$1" sess proj
  valid_name "$name" || { echo "[session] nome invalido: $name" >&2; return 1; }
  sess="$(sess_name "$name")"
  proj="$PROJECTS_DIR/$name"

  tmux has-session -t "=$sess" 2>/dev/null && return 0   # ja existe -> nada a fazer
  # o painel acabou de matar essa sessao e esta prestes a recria-la (recreateSession) --
  # nao interfere nesse instante (evita corrida com o watchdog, achado @qa 2026-09-28).
  # O lock so existe durante o kill; o proprio ensureSession do painel roda DEPOIS dele
  # ser liberado, entao nao ha deadlock aqui.
  [ -f "$RUN_DIR/$sess.lock" ] && return 0

  load_proj_config "$name"
  [ "$CFG_ENABLED" = "true" ] || return 0              # desligado -> continua desligado
  mkdir -p "$proj"

  if [ "$CFG_AUTOSTART" = "true" ]; then
    # supervisor como COMANDO DIRETO da sessao (sem send-keys -> sem race com o shell carregando)
    tmux new-session -d -s "$sess" -c "$proj" \
      "exec bash $(printf '%q' "$LOOP") $(printf '%q' "$sess") $(printf '%q' "$name")"
  else
    tmux new-session -d -s "$sess" -c "$proj" \
      "printf '\\033[90m[dev-box] projeto \"%s\": Claude DESLIGADO (painel). Rode  claude  quando quiser.\\033[0m\\n' $(printf '%q' "$name"); exec bash -l"
  fi
}

ensure_all() {
  shopt -s nullglob
  local any=0 d n
  mkdir -p "$PROJECTS_DIR"
  for d in "$PROJECTS_DIR"/*/; do
    n="$(basename "${d%/}")"
    case "$n" in .*) continue ;; esac                  # ignora pastas ocultas
    any=1
    # a falha de UMA sessao nunca aborta as outras (nem o boot)
    ensure_one "$n" || echo "[session] aviso: projeto '$n' falhou ao subir" >&2
  done
  if [ "$any" = "0" ]; then                            # container sem projeto -> cria o default
    n="${PROJECT_FOLDER:-projects}"
    mkdir -p "$PROJECTS_DIR/$n"
    ensure_one "$n" || echo "[session] aviso: projeto default '$n' falhou ao subir" >&2
  fi
}

case "${1:-}" in
  "") echo "uso: claude-session.sh <projeto> | --all" >&2; exit 2 ;;
  --all) ensure_all ;;
  *) ensure_one "$1" ;;
esac
