#!/usr/bin/env bash
# Supervisor do Claude de UMA sessao tmux (modelo multi-tmux: 1 sessao por projeto).
#
# Roda o Claude em loop: se ele sair (exit/crash), reabre em 3s. A config do projeto
# (panel.json) e RELIDA a cada inicio, entao o que mudou no painel vale sem recriar a sessao:
#   - enabled=false ou autoStartClaude=false -> nao reabre: cai num shell na pasta
#   - autoRemote=true -> apos a TUI ficar pronta, envia /remote-control <nome> (se logado)
#   - initLine        -> vai como prompt inicial (`claude "<linha>"`)
#   - <sessao>.resume -> `claude --resume <id>` (Historico -> "Continuar" no painel)
# Ctrl-C na janela de 3s entre um Claude e outro tambem cai no shell.
#
# Flag ~/.claude/run/<sessao>.running existe enquanto o Claude roda (o painel le esse flag).
# Log do supervisor (envio do remote etc.): ~/.claude/logs/sessions.log (painel -> Logs).
#
# Uso: claude-loop.sh <sessao> <projeto>
set -uo pipefail

LIB="${DEVBOX_LIB:-/usr/local/lib/devbox/lib.sh}"
# shellcheck source=devbox-lib.sh
. "$LIB"

SESS="${1:?uso: claude-loop.sh <sessao> <projeto>}"
PROJ_NAME="${2:?uso: claude-loop.sh <sessao> <projeto>}"
DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"
RUN_FLAG="$RUN_DIR/$SESS.running"
RESUME_FLAG="$RUN_DIR/$SESS.resume"
mkdir -p "$RUN_DIR" "$LOG_DIR"

gray() { printf '\033[90m%s\033[0m\n' "$*"; }
# log em arquivo (NUNCA no terminal enquanto o Claude esta na tela: sujaria a TUI)
slog() { printf '[%s] %s: %s\n' "$(date '+%F %T')" "$SESS" "$*" >> "$LOG_DIR/sessions.log"; }

# ---------- leitura da tela (tmux) ----------
screen() { tmux capture-pane -t "=$SESS:" -p -S -80 2>/dev/null; }
# TUI do Claude pronta p/ receber comando? (rodape/prompt visiveis)
tui_ready() { screen | grep -qE '(\? for shortcuts|bypass permissions|shift\+tab to cycle|^[[:space:]]*[>❯][[:space:]]*$)'; }
# remote ja ativo? (link do controle remoto ou status na tela)
remote_up() { screen | grep -qE '(claude\.ai/code/|[Rr]emote[- ]control (is )?(on|active|enabled|started|conectado|ativo))'; }
# o /remote-control abre um dialogo ("Disconnect this session / Show QR code / > Continue",
# "Enter to select · Esc to continue") que trava o prompt ate alguem apertar Enter/Esc.
dialog_open() { screen | grep -qE '(Esc to continue|Disconnect this session|Show QR code)'; }
# Claude Code 2.1.28x+: /remote-control pede CONFIRMACAO ("❯ 1. Enable Remote Control / 2. Never
# mind"). Enter aceita a opcao 1 (a default); Esc aqui seria "Never mind".
confirm_open() { screen | grep -qE '❯[[:space:]]*1\.[[:space:]]*Enable Remote Control'; }
dismiss_dialog() {
  for _ in 1 2 3 4 5; do
    dialog_open || return 0
    tmux send-keys -t "=$SESS:" Escape
    sleep 1
  done
}

# Espera a TUI ficar pronta (le a tela em vez de um sleep fixo), envia o /remote-control
# (texto e Enter em dois passos: a TUI precisa processar o texto antes do Enter), confirma
# pelo link na tela e tenta ate 3x. Sem login, nao envia.
send_remote_when_ready() {  # $1 = comando
  local cmd="$1" waited=0 attempt
  sleep "$DELAY"
  is_logged_in || { slog "remote: Claude sem login — nao enviei $cmd"; return 0; }
  until tui_ready; do
    sleep 3; waited=$((waited + 3))
    [ "$waited" -ge 120 ] && { slog "remote: TUI nao ficou pronta em 120s — envio mesmo assim"; break; }
  done
  for attempt in 1 2 3; do
    remote_up && { slog "remote: ja ativo"; dismiss_dialog; return 0; }
    tmux send-keys -t "=$SESS:" -l "$cmd"
    sleep 0.8
    tmux send-keys -t "=$SESS:" C-m
    # ate 12s: confirma o dialogo novo (se aparecer) e espera o link
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep 1
      if confirm_open; then slog "remote: confirmando 'Enable Remote Control'"; tmux send-keys -t "=$SESS:" Enter; fi
      remote_up && break
    done
    if remote_up; then slog "remote: ativo (tentativa $attempt)"; dismiss_dialog; return 0; fi
    tmux send-keys -t "=$SESS:" C-u 2>/dev/null || true   # linha ficou digitada? limpa e tenta de novo
    sleep 5
  done
  slog "remote: nao confirmei apos $attempt tentativas (use 'Religar remote' no painel)"
}

# cai num shell interativo na pasta (a sessao tmux continua viva)
drop_to_shell() {
  rm -f "$RUN_FLAG"
  gray "$*"
  exec bash -l
}

REMOTE_PID=""
cleanup() {
  rm -f "$RUN_FLAG"
  [ -n "$REMOTE_PID" ] && kill "$REMOTE_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 0' TERM HUP

while true; do
  load_proj_config "$PROJ_NAME"
  if [ "$CFG_ENABLED" != "true" ] || [ "$CFG_AUTOSTART" != "true" ]; then
    drop_to_shell "[dev-box] Claude DESLIGADO para \"$PROJ_NAME\" no painel — shell livre. Rode  claude  quando quiser."
  fi

  # remote-control em paralelo ao claude (espera a TUI ficar pronta)
  REMOTE_PID=""
  if [ "$CFG_REMOTE" = "true" ]; then
    send_remote_when_ready "$(remote_cmd "$PROJ_NAME")" &
    REMOTE_PID=$!
  fi

  RESUME_ID=""
  if [ -s "$RESUME_FLAG" ]; then
    # so a 1a linha (head -c truncava por BYTES, nao por linha: sobra de escrita concorrente
    # ou lixo apos o id virava parte do id e o --resume falhava calado com um id invalido)
    RESUME_ID="$(head -n1 "$RESUME_FLAG" | tr -cd 'A-Za-z0-9_-')"
    rm -f "$RESUME_FLAG"
    # formato esperado (history.js): ^[A-Za-z0-9_-]{6,80}$ — fora disso, ignora em vez de
    # tentar um --resume com id quebrado
    [[ "$RESUME_ID" =~ ^[A-Za-z0-9_-]{6,80}$ ]] || {
      [ -n "$RESUME_ID" ] && slog "resume: flag com formato invalido, ignorando ($RESUME_ID)"
      RESUME_ID=""
    }
  fi

  : > "$RUN_FLAG"
  slog "claude iniciado${RESUME_ID:+ (resume $RESUME_ID)}"
  if [ -n "$RESUME_ID" ]; then
    gray "[continuando a conversa $RESUME_ID]"
    claude --resume "$RESUME_ID"
  elif [ -n "$CFG_INITLINE" ]; then
    claude "$CFG_INITLINE"          # interativo, ja executando a primeira linha
  else
    claude
  fi
  rm -f "$RUN_FLAG"
  # o envio do remote pertence a ESTE Claude: se ele ja saiu, nao pode digitar no proximo
  if [ -n "$REMOTE_PID" ]; then kill "$REMOTE_PID" 2>/dev/null; wait "$REMOTE_PID" 2>/dev/null; REMOTE_PID=""; fi

  gray "[claude saiu — reabrindo em 3s | Ctrl-C = ficar no shell]"
  # Ctrl-C aqui interrompe o sleep -> cai no shell (em vez de reabrir)
  if ! (trap 'exit 130' INT; sleep 3); then
    drop_to_shell "[dev-box] supervisor pausado — shell livre. Para voltar: 'Reiniciar' no painel."
  fi
done
