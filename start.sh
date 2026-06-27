#!/usr/bin/env bash
# Entrypoint do dev-box claude (prepara como root, depois roda como usuario nao-root):
#  - settings.json com bypassPermissions (permite tudo)
#  - sessao tmux "claude" persistente, iniciada DENTRO de $PROJECT_FOLDER, rodando o Claude
#  - religa o remote-control conforme a config por projeto (panel.json -> autoRemote)
#  - sobe o code-server (IDE) se IDE_ENABLED=true
#
# Variaveis (campo Environment do EasyPanel):
#   IDE_ENABLED          true|false  -> habilita/desabilita o IDE web (default: true)
#   PROJECT_FOLDER       projects    -> pasta (dentro de /root) onde o Claude inicia
#   REMOTE_CONTROL_NAME  meu-servidor      -> nome anexado ao comando (ex.: /remote-control meu-servidor)
#   CLAUDE_AUTOCMD_DELAY 15          -> segundos de espera antes de enviar o comando
set -euo pipefail

U=ubuntu
H=/root                                  # home do usuario ubuntu = volume persistente
PROJECT_FOLDER="${PROJECT_FOLDER:-projects}"
PROJ="$H/$PROJECT_FOLDER"
REMOTE_CONTROL_NAME="${REMOTE_CONTROL_NAME:-}"
CLAUDE_AUTOCMD_DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"
# comando do remote-control = FIXO "/remote-control" + nome (se definido).
# Quem decide se DISPARA e a flag autoRemote por projeto no panel.json (lida pelo
# claude-session.sh) -> nao ha mais variavel CLAUDE_AUTOCMD.
#   ex.: REMOTE_CONTROL_NAME=meu-servidor -> "/remote-control meu-servidor"
FULL_AUTOCMD="/remote-control${REMOTE_CONTROL_NAME:+ ${REMOTE_CONTROL_NAME}}"

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

# GitHub CLI: auto-login via GH_TOKEN (item 7) + git usando gh como credential
# helper (necessario p/ o push do backup). Vazio -> pula (login manual segue ok).
if [ -n "${GH_TOKEN:-}" ]; then
  if printf '%s' "$GH_TOKEN" | as_user gh auth login --with-token >/dev/null 2>&1 \
     && as_user gh auth setup-git >/dev/null 2>&1; then
    echo ">> gh: autenticado via GH_TOKEN"
  else
    echo ">> gh: falha no login via GH_TOKEN (token valido/escopo repo?)"
  fi
fi

# Identidade git global (so define se ainda nao existir) — usada nos commits do backup.
as_user git config --global user.email >/dev/null 2>&1 || \
  as_user git config --global user.email "${GIT_AUTHOR_EMAIL:-devbox@easypanel.local}"
as_user git config --global user.name  >/dev/null 2>&1 || \
  as_user git config --global user.name  "${GIT_AUTHOR_NAME:-claude-devbox}"

# pasta ativa (onde o Claude roda) — fonte da verdade compartilhada com o painel.
# No boot, se ainda nao definida, inicia com o default $PROJ.
PROJECTS_DIR="${PROJECTS_DIR:-$H/projects}"
ACTIVE_FILE="$H/.claude/active-project"
mkdir -p "$PROJECTS_DIR"
[ -s "$ACTIVE_FILE" ] || echo "$PROJ" > "$ACTIVE_FILE"
chown -R "$U:$U" "$ACTIVE_FILE" "$PROJECTS_DIR" 2>/dev/null || true

# panel.json: config dos projetos (autoStartClaude/autoRemote por projeto). A copia VIVA
# fica no volume; semeada da imagem (/usr/local/share/claude/panel.json) so na 1a vez.
PANEL_CONFIG="${PANEL_CONFIG:-$H/.claude/panel.json}"
if [ ! -f "$PANEL_CONFIG" ] && [ -f /usr/local/share/claude/panel.json ]; then
  cp /usr/local/share/claude/panel.json "$PANEL_CONFIG"
fi
chown "$U:$U" "$PANEL_CONFIG" 2>/dev/null || true

# Garante a sessao tmux "claude" de pe na PASTA ATIVA, rodando o supervisor.
#  - claude-session.sh le a pasta ativa (active-project) e sobe o supervisor nela.
#  - O supervisor (claude-loop.sh) roda o Claude em loop: se sair (exit/crash),
#    reabre em 3s (Ctrl-C na janela de 3s cai no shell). A CADA (re)inicio RELIGA o
#    remote-control (apos o delay, se logado) — `claude` sobe conversa nova e NAO
#    reconecta sozinho. Cobre boot, respawn e recriacao pelo watchdog.
#  - Idempotente: claude-session.sh nao mexe se a sessao ja existir.
ensure_claude_session() {
  as_user env FULL_AUTOCMD="$FULL_AUTOCMD" CLAUDE_AUTOCMD_DELAY="$CLAUDE_AUTOCMD_DELAY" \
    PROJECT_FOLDER="$PROJECT_FOLDER" bash /usr/local/bin/claude-session.sh
}

# cria a sessao agora (no boot)
ensure_claude_session

# watchdog: se a sessao tmux cair sem o container reiniciar, recria em ~10s.
# Cobre o caso em que o tmux morre mas o code-server (PID 1) segue vivo.
( while true; do sleep 10; ensure_claude_session; done ) &

# Backup automatico dos projetos (item 6): a cada BACKUP_INTERVAL segundos roda
# o backup.sh, que faz commit+push de cada repo git em $PROJ. Log em
# /root/.claude/logs/backup.log. BACKUP_ENABLED=false desativa.
if [ "${BACKUP_ENABLED:-true}" = "true" ]; then
  echo ">> backup: ligado (intervalo ${BACKUP_INTERVAL:-3600}s) | log: $H/.claude/logs/backup.log"
  ( while true; do
      sleep "${BACKUP_INTERVAL:-3600}"
      as_user env PROJECT_FOLDER="$PROJECT_FOLDER" bash /usr/local/bin/backup.sh >/dev/null 2>&1 || true
    done ) &
fi

# ============================================================================
# Gateway de UMA PORTA SO (Caddy): painel em / (LOGIN+SENHA) e IDE em /ide (TOKEN).
#   - painel -> 127.0.0.1:7001 (interno; o gateway faz basic_auth PANEL_LOGIN+PANEL_PASSWORD)
#   - IDE    -> 127.0.0.1:8081 (interno, --auth password = IDE_TOKEN; FORA do basic_auth)
#   O /ide e acessivel so com o IDE_TOKEN (link compartilhavel). Porta publica: GATEWAY_PORT.
# ============================================================================
GATEWAY_PORT="${GATEWAY_PORT:-8080}"   # porta publica (aponte o dominio do EasyPanel p/ ela)
PANEL_PORT=7001                         # painel interno
IDE_PORT=8081                           # IDE interno
# Login do PAINEL (basic_auth do gateway).
PANEL_LOGIN="${PANEL_LOGIN:-admin}"
PANEL_PASSWORD="${PANEL_PASSWORD:-changeme}"
# Token do /IDE (senha NATIVA do code-server).
IDE_TOKEN="${IDE_TOKEN:-changeme}"

# respawn simples: roda um comando em loop (reabre se cair), como ubuntu, logando em arquivo
run_bg() {  # $1=label  $2=logfile  resto=comando
  local label="$1" log="$2"; shift 2
  ( while true; do as_user "$@" >> "$log" 2>&1; echo "[$label saiu — reabrindo em 3s]" >> "$log"; sleep 3; done ) &
}

# IDE: code-server interno protegido pela sua propria senha = IDE_TOKEN (--auth password).
# O gateway publica /ide SEM basic_auth -> o /ide e acessivel so com o TOKEN (compartilhavel).
if [ "${IDE_ENABLED:-true}" = "true" ]; then
  echo ">> IDE (interno $IDE_PORT, publicado em /ide | acesso pelo IDE_TOKEN)"
  run_bg "ide" "$H/.claude/logs/ide.log" \
    env PASSWORD="$IDE_TOKEN" code-server --bind-addr "127.0.0.1:$IDE_PORT" --auth password "$PROJ"
fi

# Painel "Claude Remote": SPA React buildada (dist/) + API JSON, servida pelo server.js.
# Sem auth propria — o gateway autentica. Acoes e status leem o panel.json / a sessao tmux.
if [ "${PANEL_ENABLED:-true}" = "true" ]; then
  echo ">> painel Claude Remote (interno $PANEL_PORT, publicado em / pelo gateway) | projetos: $PROJECTS_DIR"
  run_bg "painel" "$H/.claude/logs/panel.log" \
    env PANEL_BIND=127.0.0.1 PANEL_PORT="$PANEL_PORT" IDE_PATH=/ide \
      PROJECTS_DIR="$PROJECTS_DIR" FULL_AUTOCMD="$FULL_AUTOCMD" \
      node /usr/local/bin/panel/server.js
fi

# Gateway (Caddy) — PID principal. Gera o Caddyfile com a senha hasheada.
CADDYFILE="$H/.claude/Caddyfile"
PASS_HASH="$(caddy hash-password --plaintext "$PANEL_PASSWORD" 2>/dev/null || true)"
cat > "$CADDYFILE" <<CADDY
{
	auto_https off
	admin off
}
:${GATEWAY_PORT} {
	route {
		@health path /healthz
		respond @health "ok" 200

		# IDE: protegido pelo proprio code-server (--auth password = IDE_TOKEN).
		# Vem ANTES do basic_auth e o handle_path encerra a requisicao -> /ide NAO
		# passa pelo login do painel (acesso so com o TOKEN).
		redir /ide /ide/
		handle_path /ide/* {
			reverse_proxy 127.0.0.1:${IDE_PORT}
		}

		# Painel: protegido por LOGIN + PASSWORD (basic_auth do gateway)
		basic_auth {
			${PANEL_LOGIN} ${PASS_HASH}
		}
		reverse_proxy 127.0.0.1:${PANEL_PORT}
	}
}
CADDY
chown "$U:$U" "$CADDYFILE" 2>/dev/null || true
echo ">> gateway on (${GATEWAY_PORT}) | painel: / (login '${PANEL_LOGIN}' + PANEL_PASSWORD) | IDE: /ide (IDE_TOKEN)"
exec caddy run --config "$CADDYFILE" --adapter caddyfile
