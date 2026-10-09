#!/usr/bin/env bash
# Entrypoint do dev-box claude. Prepara tudo como root e roda o resto como o usuario "ubuntu":
#   1. volume /root: pastas, settings do Claude, ownership, panel.json (semente)
#   2. wrapper "claude" (root -> ubuntu), gh via GH_TOKEN, identidade git
#   3. sessoes tmux dos projetos LIGADOS (claude-session.sh --all) + watchdog
#   4. backup automatico (projetos git + config)
#   5. painel (node, interno :7001) + gateway Caddy (porta publica GATEWAY_PORT, PID principal)
#
# Variaveis: ver .env.example (todas tem default no Dockerfile).
set -euo pipefail

LIB="${DEVBOX_LIB:-/usr/local/lib/devbox/lib.sh}"
# shellcheck source=devbox-lib.sh
. "$LIB"   # so pelas funcoes de backoff (run_bg) -- os caminhos abaixo continuam proprios

U=ubuntu
H=/root                                     # home do ubuntu = volume persistente
export PROJECT_FOLDER="${PROJECT_FOLDER:-projects}"
export PROJECTS_DIR="${PROJECTS_DIR:-$H/projects}"
export PANEL_CONFIG="${PANEL_CONFIG:-$H/.claude/panel.json}"
export REMOTE_CONTROL_NAME="${REMOTE_CONTROL_NAME:-}"
export CLAUDE_AUTOCMD_DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
PANEL_PORT=7001
LOGS="$H/.claude/logs"

say() { echo ">> $*"; }
as_user() { gosu "$U" env HOME="$H" USER="$U" LOGNAME="$U" "$@"; }

# ---------------------------------------------------------------------------
# 1) volume
# ---------------------------------------------------------------------------
# SEM a pasta de logs o redirect ">> $LOGS/x.log" dos processos em background falha e eles
# nao sobem (volume novo) -> cria tudo explicitamente.
mkdir -p "$H/.claude/run" "$LOGS" "$PROJECTS_DIR"
# flags "Claude rodando" de execucoes anteriores sao orfas no boot (senao o painel mostraria
# "rodando" antes de o Claude subir)
rm -f "$H/.claude/run/"*.running 2>/dev/null || true

[ -f "$H/.claude/settings.json" ] || cat > "$H/.claude/settings.json" <<'JSON'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
JSON

# panel.json: a copia VIVA fica no volume; semeada da imagem so na 1a vez
[ -f "$PANEL_CONFIG" ] || cp /usr/local/share/claude/panel.json "$PANEL_CONFIG" 2>/dev/null || true

# ownership: so o que NAO e do ubuntu (evita reescrever o volume inteiro a cada boot)
find "$H" -xdev \( ! -user "$U" -o ! -group "$U" \) -exec chown -h "$U:$U" {} + 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2) ferramentas
# ---------------------------------------------------------------------------
# Wrapper "claude": o Claude Code RECUSA rodar como root com bypassPermissions. Em
# /usr/local/bin (precede /usr/bin no PATH): chamado como root (Console do EasyPanel),
# re-executa como ubuntu; senao chama o binario real.
REAL_CLAUDE=/usr/bin/claude
[ -x "$REAL_CLAUDE" ] || REAL_CLAUDE="$(command -v -a claude 2>/dev/null | grep -vx /usr/local/bin/claude | head -1 || true)"
if [ -n "$REAL_CLAUDE" ] && [ -x "$REAL_CLAUDE" ]; then
  cat > /usr/local/bin/claude <<WRAP
#!/usr/bin/env bash
# auto-gerado pelo start.sh — roda o Claude como o usuario nao-root "$U" quando invocado como root
[ "\$(id -u)" = "0" ] && exec gosu "$U" env HOME="$H" USER="$U" "$REAL_CLAUDE" "\$@"
exec "$REAL_CLAUDE" "\$@"
WRAP
  chmod +x /usr/local/bin/claude
fi
# alguns hooks esperam /usr/local/bin/node (o NodeSource instala em /usr/bin)
[ -e /usr/local/bin/node ] || ln -sf /usr/bin/node /usr/local/bin/node

# GitHub CLI: auto-login via GH_TOKEN + git usando o gh como credential helper (push do backup)
if [ -n "${GH_TOKEN:-}" ]; then
  if printf '%s' "$GH_TOKEN" | as_user gh auth login --with-token >/dev/null 2>&1 \
     && as_user gh auth setup-git >/dev/null 2>&1; then
    say "gh: autenticado via GH_TOKEN"
  else
    say "gh: falha no login via GH_TOKEN (token valido/escopo repo?)"
  fi
fi
# identidade git global (so define se ainda nao existir) — usada nos commits do backup
as_user git config --global user.email >/dev/null 2>&1 \
  || as_user git config --global user.email "${GIT_AUTHOR_EMAIL:-devbox@easypanel.local}"
as_user git config --global user.name >/dev/null 2>&1 \
  || as_user git config --global user.name "${GIT_AUTHOR_NAME:-claude-devbox}"

# Segredos fora do ambiente herdado: daqui pra baixo tudo que sobe (servidor tmux, sessoes do
# Claude em bypassPermissions, backups) herdaria PANEL_PASSWORD/GH_TOKEN -- um `env` dentro de
# qualquer sessao vazaria a senha do painel. Continuam como variaveis do shell (o painel recebe
# explicitamente em run_bg); o gh ja guardou o proprio login acima.
export -n PANEL_PASSWORD GH_TOKEN 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3) sessoes tmux (uma por projeto LIGADO) + watchdog
# ---------------------------------------------------------------------------
# Projeto desligado no painel (panel.json -> enabled=false) NAO sobe no boot nem e recriado
# pelo watchdog. Os ligados sobem, e se a sessao cair sem o container reiniciar, voltam em ~10s.
ensure_sessions() { as_user bash /usr/local/bin/claude-session.sh --all || say "aviso: falha ao garantir as sessoes"; }
ensure_sessions
( while sleep 10; do
    ensure_sessions >/dev/null 2>&1
    for f in "$LOGS"/panel.log "$LOGS"/sessions.log "$LOGS"/backup.log; do trim_log "$f"; done
  done ) &

# ---------------------------------------------------------------------------
# 4) backup automatico
# ---------------------------------------------------------------------------
if [ "${BACKUP_ENABLED:-true}" = "true" ]; then
  say "backup: ligado (intervalo ${BACKUP_INTERVAL:-3600}s) | log: $LOGS/backup.log"
  ( while sleep "${BACKUP_INTERVAL:-3600}"; do as_user bash /usr/local/bin/backup.sh >/dev/null 2>&1 || true; done ) &
  # snapshot da CONFIG (~/.claude + ~/.claude.json) 1x/dia -> /root/.claude-backups (rotaciona 7)
  ( sleep 120; while true; do
      as_user bash /usr/local/bin/backup.sh --config >/dev/null 2>&1 || true
      sleep "${CONFIG_BACKUP_INTERVAL:-86400}"
    done ) &
fi

# ---------------------------------------------------------------------------
# 5) painel + gateway
# ---------------------------------------------------------------------------
PANEL_LOGIN="${PANEL_LOGIN:-admin}"
PANEL_PASSWORD="${PANEL_PASSWORD:-}"
# Sem senha (ou com o default publico antigo) o PAINEL RECUSA SUBIR — fail-closed em
# panel/server/auth.js. Aqui so um aviso claro no boot; o valor NUNCA vai para o log.
if [ -z "$PANEL_PASSWORD" ]; then
  say "[SEGURANCA] PANEL_PASSWORD vazio -> o painel NAO vai subir. Defina no Environment do EasyPanel."
elif [ "$(printf '%s' "$PANEL_PASSWORD" | sha256sum | cut -c1-64)" = "98a2fc5119f2b61af6d90d9d7bb59813820e6cd43411eeb0a91484a769a0ccb9" ]; then
  say "[SEGURANCA] PANEL_PASSWORD e o default PUBLICO que ja esteve no repo -> o painel NAO vai subir. Troque no Environment."
fi

# respawn com backoff: roda um comando em loop (reabre se cair), como ubuntu, logando em
# arquivo. Sem backoff, um processo em crash-loop (bug/OOM) reabre a cada 3s pra sempre e
# sozinho sobrecarrega a VM — ver devbox-lib.sh#backoff_next.
run_bg() {  # $1=label  $2=logfile  resto=comando
  local label="$1" log="$2" fails=0 t0 ran delay; shift 2
  ( while true; do
      t0=$(date +%s)
      as_user "$@" >> "$log" 2>&1 || true
      ran=$(( $(date +%s) - t0 ))
      fails="$(backoff_next "$fails" "$ran")"
      delay="$(backoff_sleep "$fails")"
      echo "[$label saiu (rodou ${ran}s) — reabrindo em ${delay}s]" >> "$log"
      sleep "$delay"
    done ) &
}

if [ "${PANEL_ENABLED:-true}" = "true" ]; then
  say "painel Claude Remote (interno $PANEL_PORT, publicado em / pelo gateway) | projetos: $PROJECTS_DIR"
  run_bg "painel" "$LOGS/panel.log" \
    env PANEL_BIND=127.0.0.1 PANEL_PORT="$PANEL_PORT" \
      PROJECTS_DIR="$PROJECTS_DIR" PANEL_CONFIG="$PANEL_CONFIG" PROJECT_FOLDER="$PROJECT_FOLDER" \
      REMOTE_CONTROL_NAME="$REMOTE_CONTROL_NAME" CLAUDE_AUTOCMD_DELAY="$CLAUDE_AUTOCMD_DELAY" \
      PANEL_LOGIN="$PANEL_LOGIN" PANEL_PASSWORD="$PANEL_PASSWORD" \
      PANEL_SESSION_DAYS="${PANEL_SESSION_DAYS:-30}" \
      BACKUP_ENABLED="${BACKUP_ENABLED:-true}" BACKUP_INTERVAL="${BACKUP_INTERVAL:-3600}" \
      GATEWAY_PORT="$GATEWAY_PORT" GH_TOKEN="${GH_TOKEN:-}" \
      GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-}" TZ="${TZ:-}" \
      TERM=xterm-256color \
      node /usr/local/bin/panel/server.js
fi

# Gateway (Caddy) — PID principal. So faz proxy: o painel tem login proprio (cookie de sessao).
CADDYFILE="$H/.claude/Caddyfile"
cat > "$CADDYFILE" <<CADDY
{
	auto_https off
	admin off
	# o Traefik do EasyPanel fica na frente: sem isso o Caddy sobrescreve X-Forwarded-For/Proto
	# (todo cliente vira o IP do Traefik -> rate-limit do login compartilhado; HTTPS invisivel)
	servers {
		trusted_proxies static private_ranges
	}
}
:${GATEWAY_PORT} {
	route {
		@health path /healthz
		respond @health "ok" 200
		reverse_proxy 127.0.0.1:${PANEL_PORT}
	}
}
CADDY
chown "$U:$U" "$CADDYFILE" 2>/dev/null || true
say "gateway on (:${GATEWAY_PORT}) | painel: / (login '${PANEL_LOGIN}')"
exec caddy run --config "$CADDYFILE" --adapter caddyfile
