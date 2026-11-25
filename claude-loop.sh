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
PAUSE_FLAG="$RUN_DIR/$SESS.paused"
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

# Workspace novo (achado @qa 2026-09-29, ao vivo): a 1a vez que o Claude abre uma pasta ele
# pede "Is this project you created or one you trust?" com um menu SEM numeros onde o item
# default (cursor "❯") e' "No, exit" -- sem essa automacao, TODA sessao nova trava esperando
# alguem clicar "Yes, I trust this folder" manualmente no terminal web (o painel nao roda
# nada — nem o /remote-control — enquanto esse dialogo estiver na tela). Automatiza: manda
# Down (move o cursor pra "Yes, I trust this folder") + Enter.
trust_prompt_open() { screen | grep -qE 'Is this project you created or one you trust|trust this folder'; }
accept_trust_prompt() {
  local waited=0
  until trust_prompt_open; do
    tui_ready && return 0                    # workspace ja confiavel -> nunca apareceu
    sleep 1; waited=$((waited + 1))
    [ "$waited" -ge 60 ] && return 0          # nao apareceu em 60s -> nao insiste
  done
  for _ in 1 2 3 4 5; do
    trust_prompt_open || { slog "trust: workspace trusted, TUI unlocked"; return 0; }
    tmux send-keys -t "=$SESS:" Down
    sleep 0.3
    tmux send-keys -t "=$SESS:" Enter
    sleep 1
  done
  slog "trust: the trust dialog did not go away after 5 tries — check it by hand"
}

# Espera a TUI ficar pronta (le a tela em vez de um sleep fixo), envia o /remote-control
# (texto e Enter em dois passos: a TUI precisa processar o texto antes do Enter), confirma
# pelo link na tela e tenta ate 3x. Sem login, nao envia.
send_remote_when_ready() {  # $1 = comando
  local cmd="$1" waited=0 attempt
  sleep "$DELAY"
  is_logged_in || { slog "remote: Claude is not logged in — did not send $cmd"; return 0; }
  until tui_ready; do
    sleep 3; waited=$((waited + 3))
    [ "$waited" -ge 120 ] && { slog "remote: TUI not ready after 120s — sending anyway"; break; }
  done
  for attempt in 1 2 3; do
    remote_up && { slog "remote: already on"; dismiss_dialog; return 0; }
    tmux send-keys -t "=$SESS:" -l "$cmd"
    sleep 0.8
    tmux send-keys -t "=$SESS:" C-m
    # ate 12s: confirma o dialogo novo (se aparecer) e espera o link
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
      sleep 1
      if confirm_open; then slog "remote: confirming 'Enable Remote Control'"; tmux send-keys -t "=$SESS:" Enter; fi
      remote_up && break
    done
    if remote_up; then slog "remote: on (attempt $attempt)"; dismiss_dialog; return 0; fi
    tmux send-keys -t "=$SESS:" C-u 2>/dev/null || true   # linha ficou digitada? limpa e tenta de novo
    sleep 5
  done
  slog "remote: not confirmed after $attempt attempts (use 'Restart remote' in the panel)"
}

# ---------- volta automatica da versao do Claude Code ----------
# Toda imagem nova traz o Claude "latest". Se ele crashar em loop, volta UMA vez para a ultima
# versao que rodou saudavel aqui (gravada no volume) -- o build ja reprova binario quebrado, isto
# cobre o que so quebra em uso. Uma tentativa por versao (flag), serializada entre projetos (flock).
GOOD_FILE="$RUN_DIR/claude-good-version"
claude_ver() { claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1; }
record_good_claude() {
  local v; v="$(claude_ver)"
  [ -n "$v" ] && [ "$(cat "$GOOD_FILE" 2>/dev/null)" != "$v" ] && printf '%s\n' "$v" > "$GOOD_FILE"
  return 0
}
rollback_claude() {
  local cur good tried
  good="$(cat "$GOOD_FILE" 2>/dev/null)"; cur="$(claude_ver)"
  [ -n "$good" ] && [ -n "$cur" ] && [ "$good" != "$cur" ] || return 1
  tried="$RUN_DIR/claude-rollback-tried-$cur"
  [ -e "$tried" ] && return 1
  : > "$tried"
  slog "rollback: Claude $cur in a crash-loop — going back to $good (last healthy)"
  if ( flock 8; timeout 300 sudo -n npm install -g --include=optional "@anthropic-ai/claude-code@$good" ) \
       8>"$RUN_DIR/claude-rollback.lock" >>"$LOG_DIR/sessions.log" 2>&1 && [ "$(claude_ver)" = "$good" ]; then
    alert warn claude-update "$PROJ_NAME" "Claude $cur kept crashing — automatically went back to $good." srv.alert.rolledBack "cur=$cur" "good=$good"
    return 0
  fi
  alert error claude-update "$PROJ_NAME" "Claude $cur kept crashing and going back to $good failed — see Logs → Sessions." srv.alert.rollbackFailed "cur=$cur" "good=$good"
  return 1
}

# cai num shell interativo na pasta (a sessao tmux continua viva)
drop_to_shell() {
  rm -f "$RUN_FLAG"
  gray "$*"
  exec bash -l
}

REMOTE_PID=""
TRUST_PID=""
cleanup() {
  rm -f "$RUN_FLAG"
  [ -n "$REMOTE_PID" ] && kill "$REMOTE_PID" 2>/dev/null
  [ -n "$TRUST_PID" ] && kill "$TRUST_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 0' TERM HUP

FAILS=0  # consecutivos; zera quando o Claude roda tempo suficiente (ver backoff_next)
while true; do
  load_proj_config "$PROJ_NAME"
  if [ "$CFG_ENABLED" != "true" ] || [ "$CFG_AUTOSTART" != "true" ]; then
    drop_to_shell "[dev-box] Claude is OFF for \"$PROJ_NAME\" in the panel — free shell. Run  claude  whenever you want."
  fi

  # Pausado (inatividade ou "Pausar" no painel): nao reabre ate o painel tirar o flag ou alguem
  # apertar Enter aqui. A conversa fica salva -- com sessao fixa/continuar, volta onde parou.
  if [ -e "$PAUSE_FLAG" ]; then
    rm -f "$RUN_FLAG"
    slog "paused ($(head -c 20 "$PAUSE_FLAG" 2>/dev/null)) — waiting to resume"
    gray "[Claude paused ($(head -c 20 "$PAUSE_FLAG" 2>/dev/null)) — press Enter here or 'Resume' in the panel]"
    while [ -e "$PAUSE_FLAG" ]; do
      if read -r -t 5 _; then rm -f "$PAUSE_FLAG"; fi
    done
    FAILS=0
    slog "resumed"
  fi

  # aceita o "trust this folder" sozinho (roda sempre, mesmo sem remote): sem isso nada mais
  # nesta sessao avanca -- nem a TUI fica pronta, nem o /remote-control abaixo consegue rodar
  accept_trust_prompt &
  TRUST_PID=$!

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
      [ -n "$RESUME_ID" ] && slog "resume: flag has an invalid format, ignoring ($RESUME_ID)"
      RESUME_ID=""
    }
  fi

  # Sessao fixa (panel.json -> sessionMode): o "Continuar" do Historico (RESUME_ID) vence; senao
  # "pinned" reabre sempre a conversa escolhida e "continue" a mais recente da pasta. So retoma o
  # que existe em disco: --continue/--resume sem conversa sairia na hora e contaria como crash.
  CONTINUE=""
  CDIR="$(conv_dir "$PWD")"
  if [ -z "$RESUME_ID" ] && [ "$CFG_SESSMODE" = "pinned" ]; then
    if [ -n "$CFG_PINNED" ] && [ -f "$CDIR/$CFG_PINNED.jsonl" ]; then
      RESUME_ID="$CFG_PINNED"
    else
      slog "pinned session: conversation '${CFG_PINNED:-?}' not found — opening a new one"
    fi
  elif [ -z "$RESUME_ID" ] && [ "$CFG_SESSMODE" = "continue" ]; then
    if compgen -G "$CDIR/*.jsonl" >/dev/null; then CONTINUE=1
    else slog "continue: no previous conversation in this folder — opening a new one"; fi
  fi

  : > "$RUN_FLAG"
  slog "claude started${RESUME_ID:+ (resume $RESUME_ID)}${CONTINUE:+ (continue)}"
  T0=$(date +%s)
  # retomando conversa, a "primeira linha" NAO e reenviada (repetiria o pedido a cada reinicio)
  if [ -n "$RESUME_ID" ]; then
    gray "[continuing conversation $RESUME_ID]"
    claude --resume "$RESUME_ID"
  elif [ -n "$CONTINUE" ]; then
    gray "[continuing the last conversation in this folder]"
    claude --continue
  elif [ -n "$CFG_INITLINE" ]; then
    # interativo, ja executando a primeira linha; "-..." viraria flag do CLI -> espaco na frente
    case "$CFG_INITLINE" in -*) CFG_INITLINE=" $CFG_INITLINE" ;; esac
    claude "$CFG_INITLINE"
  else
    claude
  fi
  rc=$?
  RAN_FOR=$(( $(date +%s) - T0 ))
  # exit code in the log: 0 = normal exit (/exit, Ctrl-D); 137 = SIGKILL (OOM/kill); 134 = abort
  # (e.g. V8 heap out of memory); 129/143 = HUP/TERM. Without it a dropped session leaves no clue.
  slog "claude exited (code $rc, ran ${RAN_FOR}s)"
  rm -f "$RUN_FLAG"
  # o envio do remote/trust pertence a ESTE Claude: se ele ja saiu, nao pode digitar no proximo
  if [ -n "$REMOTE_PID" ]; then kill "$REMOTE_PID" 2>/dev/null; wait "$REMOTE_PID" 2>/dev/null; REMOTE_PID=""; fi
  if [ -n "$TRUST_PID" ]; then kill "$TRUST_PID" 2>/dev/null; wait "$TRUST_PID" 2>/dev/null; TRUST_PID=""; fi

  # Backoff: sem isso, um Claude que crasha rapido (bug/OOM) reabre a cada 3s PRA SEMPRE e
  # sozinho ja sobrecarrega a VM (CPU+memoria de cada reabertura, sem teto). Roda tempo o
  # bastante (MIN_HEALTHY_RUN_S) -> zera o contador, era uso normal.
  FAILS="$(backoff_next "$FAILS" "$RAN_FOR")"
  [ "$FAILS" = "0" ] && record_good_claude
  if [ "$FAILS" -ge "$MAX_FAST_FAILS" ] && rollback_claude; then
    FAILS=0
  fi
  if [ "$FAILS" -ge "$MAX_FAST_FAILS" ]; then
    slog "crash-loop: claude exited $FAILS times in a row too fast — no longer restarting it"
    alert error crash-loop "$PROJ_NAME" "Claude crashed $FAILS times in a row (last code $rc) — stopped restarting it. See Logs → Sessions." srv.alert.crashLoop "n=$FAILS" "rc=$rc"
    drop_to_shell "[dev-box] Claude exited $FAILS times in a row too fast — stopped restarting it so the VM is not overloaded. Free shell; run  claude  whenever you want (or 'Restart' in the panel to start over)."
  fi
  WAIT="$(backoff_sleep "$FAILS")"
  gray "[claude exited — restarting in ${WAIT}s | Ctrl-C = stay in the shell]"
  # Ctrl-C aqui interrompe o sleep -> cai no shell (em vez de reabrir)
  if ! (trap 'exit 130' INT; sleep "$WAIT"); then
    drop_to_shell "[dev-box] supervisor paused — free shell. To come back: 'Restart' in the panel."
  fi
done
