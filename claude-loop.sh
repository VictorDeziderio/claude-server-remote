#!/usr/bin/env bash
# Supervisor do Claude para UMA sessao tmux (modelo multi-tmux: 1 sessao por projeto).
# Roda o Claude em loop: se ele sair (exit/crash), reabre em 3s. A CADA (re)inicio, apos o
# Claude carregar, envia (se logado):
#   1) o remote-control (se autoRemote)  2) a "primeira linha" do projeto (panel.json -> initLine)
# `claude` sobe conversa nova e NAO reconecta sozinho, por isso reenviamos a cada inicio.
# Para cair no shell: Ctrl-C na janela de 3s.
#
# Mantem um FLAG FILE por sessao (~/.claude/run/<sessao>.running) enquanto o Claude roda
# (o painel le esse flag em vez de adivinhar pelo pane_current_command, que da falso-negativo).
#
# Args:  $1 = nome da sessao tmux (ex.: claude-pilot)
#        $2 = comando do remote-control (ex.: "/remote-control pilot"; vazio desativa)
#        $3 = segundos de espera antes de enviar (Claude carregar)
#        $4 = nome do projeto (p/ ler a "primeira linha" no panel.json)
set -uo pipefail
SESS="${1:?uso: claude-loop.sh <sessao> [remote_cmd] [delay] [projeto]}"
FULL_AUTOCMD="${2:-}"
DELAY="${3:-15}"
PROJ_NAME="${4:-}"

# Garante node/claude no PATH mesmo quando iniciado como COMANDO DIRETO da sessao tmux
# (nesse caso o PATH herdado pode ser minimo e nao conter o node -> read_initline falhava).
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin${PATH:+:$PATH}"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/bin/node)"

H="${HOME:-/root}"
RUN_DIR="$H/.claude/run"
RUN_FLAG="$RUN_DIR/$SESS.running"
mkdir -p "$RUN_DIR"

# verdadeiro se o Claude ja estiver logado (/login feito)
is_logged_in() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -s "$H/.claude/.credentials.json" ] && return 0
  grep -qE '"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"' "$H/.claude.json" 2>/dev/null && return 0
  return 1
}

# le a "primeira linha" do projeto no panel.json (vazio se nao definida). Usa node (sempre presente).
read_initline() {
  [ -n "$PROJ_NAME" ] || return 0
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [,, file, proj] = process.argv;
    let c = {}; try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const o = (c.projects && c.projects[proj]) || {};
    process.stdout.write(typeof o.initLine === "string" ? o.initLine : "");
  ' "$H/.claude/panel.json" "$PROJ_NAME" 2>/dev/null
}

# tela atual da sessao (ultimas 80 linhas)
screen() { tmux capture-pane -t "$SESS" -p -S -80 2>/dev/null; }
# TUI do Claude pronta p/ receber comando? (rodape/prompt visiveis)
tui_ready() { screen | grep -qE '(\? for shortcuts|bypass permissions|shift\+tab to cycle|^[[:space:]]*[>❯][[:space:]]*$)'; }
# remote ja ativo? (link do controle remoto ou status na tela)
remote_up() { screen | grep -qE '(claude\.ai/code/|[Rr]emote[- ]control (is )?(on|active|enabled|started|conectado|ativo))'; }
# o /remote-control abre um dialogo ("Disconnect this session / Show QR code / > Continue",
# "Enter to select · Esc to continue") que trava o prompt ate alguem apertar Enter/Esc.
dialog_open() { screen | grep -qE '(Esc to continue|Disconnect this session|Show QR code)'; }
dismiss_dialog() {
  local i=0
  while [ "$i" -lt 5 ]; do
    dialog_open || return 0
    tmux send-keys -t "$SESS" Escape
    sleep 1; i=$((i + 1))
  done
}

send_remote_when_ready() {
  local waited=0 attempt=0
  sleep "$DELAY"
  is_logged_in || { echo "[remote] sem login — nao enviei $FULL_AUTOCMD"; return 0; }
  # espera a TUI (ate 120s)
  while ! tui_ready; do
    sleep 3; waited=$((waited + 3))
    [ "$waited" -ge 120 ] && { echo "[remote] TUI nao ficou pronta em 120s — envio mesmo assim"; break; }
  done
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    remote_up && { echo "[remote] ja ativo"; dismiss_dialog; return 0; }
    tmux send-keys -t "$SESS" -l "$FULL_AUTOCMD"
    sleep 0.8
    tmux send-keys -t "$SESS" C-m
    sleep 12
    if remote_up; then
      echo "[remote] ativo (tentativa $attempt)"
      dismiss_dialog          # fecha o dialogo de confirmacao -> volta ao prompt
      return 0
    fi
    # se a linha ficou digitada sem enviar, limpa antes de tentar de novo
    tmux send-keys -t "$SESS" C-u 2>/dev/null || true
    sleep 5
  done
  echo "[remote] nao confirmei o remote apos $attempt tentativas (use 'Religar remote' no painel)"
}

# garante que o flag suma se o supervisor for encerrado (kill-session, etc.)
cleanup() { rm -f "$RUN_FLAG"; }
trap cleanup EXIT INT TERM

while true; do
  # PRIMEIRA LINHA: passada como PROMPT INICIAL do `claude` (forma documentada `claude "query"`,
  # que mantem a sessao interativa). Executa de forma 100% confiavel, sem send-keys fragil
  # (o send-keys falhava com a TUI do Claude por causa do bracketed paste).
  IL="$(read_initline)"

  # REMOTE-CONTROL: em paralelo ao `claude`, ESPERA A TUI FICAR PRONTA (le a tela em vez de
  # um sleep fixo — em container lento 15s nao bastavam), manda o texto e o Enter em dois
  # passos (a TUI precisa processar o texto antes do Enter), VERIFICA se o remote subiu
  # (link claude.ai/code na tela) e tenta de novo ate 3x. Sem login, nao envia.
  if [ -n "$FULL_AUTOCMD" ]; then
    ( send_remote_when_ready ) &
  fi

  # CONTINUAR CONVERSA: o painel (Historico -> "Continuar") grava <sessao>.resume com o id da
  # conversa e derruba o Claude; aqui reabrimos com `claude --resume <id>` (uma vez) e apagamos o flag.
  RESUME_FLAG="$RUN_DIR/$SESS.resume"
  RESUME_ID=""
  if [ -s "$RESUME_FLAG" ]; then
    RESUME_ID="$(head -c 100 "$RESUME_FLAG" | tr -cd 'A-Za-z0-9_-')"
    rm -f "$RESUME_FLAG"
  fi

  : > "$RUN_FLAG"               # marca: Claude rodando
  if [ -n "$RESUME_ID" ]; then
    echo "[continuando a conversa $RESUME_ID]"
    claude --resume "$RESUME_ID"
  elif [ -n "$IL" ]; then
    claude "$IL"                # inicia interativo JA executando a primeira linha
  else
    claude
  fi
  rm -f "$RUN_FLAG"             # marca: Claude parado (caiu no shell ou crashou)

  echo "[claude saiu — reabrindo em 3s | Ctrl-C cancela]"
  sleep 3
done
