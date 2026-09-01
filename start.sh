#!/usr/bin/env bash
# Entrypoint do dev-box claude (prepara como root, depois roda como usuario nao-root):
#  - settings.json com bypassPermissions (permite tudo)
#  - UMA sessao tmux por projeto (claude-<nome>), cada uma rodando o Claude (modelo multi-tmux)
#  - religa o remote-control conforme a config por projeto (panel.json -> autoRemote)
#
# Variaveis (campo Environment do EasyPanel):
#   PROJECT_FOLDER       projects    -> nome do projeto default (se o container subir sem nenhum)
#   REMOTE_CONTROL_NAME  (vazio)     -> remote usa o NOME DO PROJETO; defina p/ forcar um nome fixo
#   CLAUDE_AUTOCMD_DELAY 15          -> segundos de espera antes de enviar o comando
set -euo pipefail

U=ubuntu
H=/root                                  # home do usuario ubuntu = volume persistente
PROJECT_FOLDER="${PROJECT_FOLDER:-projects}"
PROJ="$H/$PROJECT_FOLDER"
REMOTE_CONTROL_NAME="${REMOTE_CONTROL_NAME:-}"
CLAUDE_AUTOCMD_DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"
# Modelo multi-tmux: cada projeto tem sua sessao "claude-<nome>" e seu remote-control,
# cujo nome = o NOME DO PROJETO (ex.: "/remote-control pilot"). REMOTE_CONTROL_NAME, se
# definido, FORCA um nome fixo p/ todos (override). Vazio (default) -> usa o nome do projeto.
# O claude-session.sh monta o comando por projeto; o painel (server.js) faz o mesmo.

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

# flags de "Claude rodando" (claude-loop.sh) ficam no volume -> limpa orfas de execucoes
# anteriores no boot, senao o painel mostraria "rodando" antes de o Claude realmente subir.
mkdir -p "$H/.claude/run"
rm -f "$H/.claude/run/"*.running 2>/dev/null || true

# logs do painel/backup. SEM esta pasta, o redirect ">> .../logs/x.log" dos run_bg falha e
# (com set -e herdado no subshell) mata o processo ANTES de subir -> painel/backup nao iniciam.
# Em volume NOVO a pasta nao existe, entao precisa ser criada explicitamente no boot.
mkdir -p "$H/.claude/logs"

# ownership do volume p/ o usuario nao-root
chown -R "$U:$U" "$H" 2>/dev/null || true

# helper: roda como ubuntu, com HOME no volume
as_user() { gosu "$U" env HOME="$H" USER="$U" "$@"; }

# Wrapper "claude": o Claude Code RECUSA rodar como root (o managed-settings usa
# bypassPermissions, equivalente a --dangerously-skip-permissions, bloqueado para root).
# Este wrapper em /usr/local/bin (precede /usr/bin no PATH): se "claude" for chamado como
# root (ex.: Console do EasyPanel), re-executa como o usuario "ubuntu"; senao chama o real.
REAL_CLAUDE=/usr/bin/claude
[ -x "$REAL_CLAUDE" ] || REAL_CLAUDE="$(command -v claude 2>/dev/null | grep -vx /usr/local/bin/claude | head -1)"
if [ -n "$REAL_CLAUDE" ] && [ -x "$REAL_CLAUDE" ]; then
  cat > /usr/local/bin/claude <<WRAP
#!/usr/bin/env bash
# auto-gerado pelo start.sh — roda o Claude como o usuario nao-root "ubuntu" quando invocado como root
if [ "\$(id -u)" = "0" ]; then
  exec gosu "$U" env HOME="$H" USER="$U" "$REAL_CLAUDE" "\$@"
fi
exec "$REAL_CLAUDE" "\$@"
WRAP
  chmod +x /usr/local/bin/claude
  echo ">> wrapper 'claude' instalado (root -> ubuntu) | real: $REAL_CLAUDE"
fi

# O NodeSource instala o node em /usr/bin, mas alguns hooks (ex.: SessionStart) e ferramentas
# esperam /usr/local/bin/node. Symlink evita o erro "/usr/local/bin/node: not found".
if [ ! -e /usr/local/bin/node ] && [ -x /usr/bin/node ]; then
  ln -sf /usr/bin/node /usr/local/bin/node
fi

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

# diretorio container dos projetos (cada subpasta = um projeto = uma sessao tmux).
PROJECTS_DIR="${PROJECTS_DIR:-$H/projects}"
mkdir -p "$PROJECTS_DIR"
chown -R "$U:$U" "$PROJECTS_DIR" 2>/dev/null || true

# panel.json: config dos projetos (autoStartClaude/autoRemote por projeto). A copia VIVA
# fica no volume; semeada da imagem (/usr/local/share/claude/panel.json) so na 1a vez.
PANEL_CONFIG="${PANEL_CONFIG:-$H/.claude/panel.json}"
if [ ! -f "$PANEL_CONFIG" ] && [ -f /usr/local/share/claude/panel.json ]; then
  cp /usr/local/share/claude/panel.json "$PANEL_CONFIG"
fi
chown "$U:$U" "$PANEL_CONFIG" 2>/dev/null || true

# Modelo multi-tmux: garante UMA sessao tmux por projeto (claude-<nome>), cada uma rodando
# o supervisor (claude-loop.sh) na pasta do projeto. O supervisor roda o Claude em loop:
# se sair (exit/crash), reabre em 3s; a cada (re)inicio religa o remote-control (se logado).
# Idempotente: claude-session.sh nao mexe em sessao ja existente. Cobre boot, respawn e watchdog.
ensure_one() {  # $1 = nome do projeto
  as_user env CLAUDE_AUTOCMD_DELAY="$CLAUDE_AUTOCMD_DELAY" PROJECTS_DIR="$PROJECTS_DIR" \
    PANEL_CONFIG="$PANEL_CONFIG" REMOTE_CONTROL_NAME="$REMOTE_CONTROL_NAME" \
    bash /usr/local/bin/claude-session.sh "$1"
}
ensure_all_sessions() {
  shopt -s nullglob
  local any=0 d n
  for d in "$PROJECTS_DIR"/*/; do
    n="$(basename "${d%/}")"
    case "$n" in .*) continue ;; esac      # ignora pastas ocultas
    any=1
    # nunca deixa a falha de UMA sessao abortar o boot (set -e) -> o gateway precisa subir
    ensure_one "$n" || echo ">> aviso: sessao do projeto '$n' falhou ao subir (segue o boot)"
  done
  # container ainda sem nenhum projeto -> cria o default ($PROJECT_FOLDER) e sobe a sessao dele
  if [ "$any" = "0" ]; then
    local def="${PROJECT_FOLDER:-projects}"
    mkdir -p "$PROJECTS_DIR/$def"; chown -R "$U:$U" "$PROJECTS_DIR/$def" 2>/dev/null || true
    ensure_one "$def" || echo ">> aviso: sessao default '$def' falhou ao subir (segue o boot)"
  fi
}

# cria as sessoes agora (no boot)
ensure_all_sessions

# watchdog: se alguma sessao cair sem o container reiniciar, recria em ~10s.
( while true; do sleep 10; ensure_all_sessions; done ) &

# Backup automatico dos projetos (item 6): a cada BACKUP_INTERVAL segundos roda
# o backup.sh, que faz commit+push de cada repo git em $PROJ. Log em
# /root/.claude/logs/backup.log. BACKUP_ENABLED=false desativa.
if [ "${BACKUP_ENABLED:-true}" = "true" ]; then
  echo ">> backup: ligado (intervalo ${BACKUP_INTERVAL:-3600}s) | log: $H/.claude/logs/backup.log"
  ( while true; do
      sleep "${BACKUP_INTERVAL:-3600}"
      as_user env PROJECT_FOLDER="$PROJECT_FOLDER" bash /usr/local/bin/backup.sh >/dev/null 2>&1 || true
    done ) &
  # backup da CONFIG (~/.claude + ~/.claude.json) 1x/dia -> /root/.claude-backups (rotaciona 7).
  # Baixe pelo painel (Backup) de tempos em tempos: se o volume sumir, o login/config vao junto.
  ( sleep 120; while true; do
      as_user bash /usr/local/bin/backup.sh --config >/dev/null 2>&1 || true
      sleep "${CONFIG_BACKUP_INTERVAL:-86400}"
    done ) &
fi

# ============================================================================
# Gateway de UMA PORTA SO (Caddy): painel em / (LOGIN+SENHA).
#   - painel -> 127.0.0.1:7001 (interno; tem PAGINA DE LOGIN propria, cookie de sessao)
#   Porta publica: GATEWAY_PORT.
# ============================================================================
GATEWAY_PORT="${GATEWAY_PORT:-8080}"   # porta publica (aponte o dominio do EasyPanel p/ ela)
PANEL_PORT=7001                         # painel interno
# Login do PAINEL (pagina de login propria do server.js).
PANEL_LOGIN="${PANEL_LOGIN:-admin}"
PANEL_PASSWORD="${PANEL_PASSWORD:-changeme}"

# Aviso de seguranca: senha fraca/default. Nao bloqueia (uso pessoal),
# so alerta no log para o dono trocar no Environment do EasyPanel.
DEFAULT_CRED='senha-antiga-removida'
warn_cred() { echo ">> [SEGURANCA] $*"; }
case "$PANEL_PASSWORD" in
  ''|changeme|"$DEFAULT_CRED") warn_cred "PANEL_PASSWORD esta no DEFAULT/vazio — troque por uma senha forte." ;;
esac

# respawn simples: roda um comando em loop (reabre se cair), como ubuntu, logando em arquivo
run_bg() {  # $1=label  $2=logfile  resto=comando
  local label="$1" log="$2"; shift 2
  ( while true; do as_user "$@" >> "$log" 2>&1; echo "[$label saiu — reabrindo em 3s]" >> "$log"; sleep 3; done ) &
}

# Painel "Claude Remote": SPA React buildada (dist/) + API JSON + terminal WebSocket/PTY,
# tudo servido pelo server.js (login proprio com cookie de sessao assinado). Roda como
# ubuntu -> mesmo uid das sessoes tmux, entao o `tmux attach` do terminal enxerga todas.
if [ "${PANEL_ENABLED:-true}" = "true" ]; then
  echo ">> painel Claude Remote (interno $PANEL_PORT, publicado em / pelo gateway) | projetos: $PROJECTS_DIR"
  run_bg "painel" "$H/.claude/logs/panel.log" \
    env PANEL_BIND=127.0.0.1 PANEL_PORT="$PANEL_PORT" \
      PROJECTS_DIR="$PROJECTS_DIR" PANEL_CONFIG="$PANEL_CONFIG" \
      REMOTE_CONTROL_NAME="$REMOTE_CONTROL_NAME" CLAUDE_AUTOCMD_DELAY="$CLAUDE_AUTOCMD_DELAY" \
      PANEL_LOGIN="$PANEL_LOGIN" PANEL_PASSWORD="$PANEL_PASSWORD" \
      PANEL_SESSION_DAYS="${PANEL_SESSION_DAYS:-30}" \
      BACKUP_ENABLED="${BACKUP_ENABLED:-true}" BACKUP_INTERVAL="${BACKUP_INTERVAL:-3600}" \
      GATEWAY_PORT="$GATEWAY_PORT" PROJECT_FOLDER="$PROJECT_FOLDER" GH_TOKEN="${GH_TOKEN:-}" \
      GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-}" TZ="${TZ:-}" \
      TERM=xterm-256color \
      node /usr/local/bin/panel/server.js
fi

# Gateway (Caddy) — PID principal. So faz proxy: o painel tem PAGINA DE LOGIN propria
# (cookie de sessao). Sem basic_auth aqui.
CADDYFILE="$H/.claude/Caddyfile"
cat > "$CADDYFILE" <<CADDY
{
	auto_https off
	admin off
}
:${GATEWAY_PORT} {
	route {
		@health path /healthz
		respond @health "ok" 200

		# Painel "Claude Remote": pagina de login propria (PANEL_LOGIN + PANEL_PASSWORD).
		reverse_proxy 127.0.0.1:${PANEL_PORT}
	}
}
CADDY
chown "$U:$U" "$CADDYFILE" 2>/dev/null || true
echo ">> gateway on (${GATEWAY_PORT}) | painel: / (login proprio '${PANEL_LOGIN}')"
exec caddy run --config "$CADDYFILE" --adapter caddyfile
