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

# garante que o flag suma se o supervisor for encerrado (kill-session, etc.)
cleanup() { rm -f "$RUN_FLAG"; }
trap cleanup EXIT INT TERM

while true; do
  # PRIMEIRA LINHA: passada como PROMPT INICIAL do `claude` (forma documentada `claude "query"`,
  # que mantem a sessao interativa). Executa de forma 100% confiavel, sem send-keys fragil
  # (o send-keys falhava com a TUI do Claude por causa do bracketed paste).
  IL="$(read_initline)"

  # REMOTE-CONTROL: vai por send-keys DEPOIS que o Claude carregar (em paralelo ao `claude`).
  # C-m (Enter real) e mais confiavel que "Enter" com a TUI do Claude.
  if [ -n "$FULL_AUTOCMD" ]; then
    ( sleep "$DELAY"
      is_logged_in && tmux send-keys -t "$SESS" "$FULL_AUTOCMD" C-m
    ) &
  fi

  : > "$RUN_FLAG"               # marca: Claude rodando
  if [ -n "$IL" ]; then
    claude "$IL"                # inicia interativo JA executando a primeira linha
  else
    claude
  fi
  rm -f "$RUN_FLAG"             # marca: Claude parado (caiu no shell ou crashou)

  echo "[claude saiu — reabrindo em 3s | Ctrl-C cancela]"
  sleep 3
done
