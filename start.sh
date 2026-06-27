#!/usr/bin/env bash
# Entrypoint do dev-box claude (prepara como root, depois roda como usuario nao-root):
#  - settings.json com bypassPermissions (permite tudo)
#  - sessao tmux "claude" persistente, iniciada DENTRO de $PROJECT_FOLDER, rodando o Claude
#  - apos o Claude carregar, envia automaticamente o comando $CLAUDE_AUTOCMD
#  - sobe o code-server (IDE) se IDE_ENABLED=true
#
# Variaveis (campo Environment do EasyPanel):
#   IDE_ENABLED          true|false  -> habilita/desabilita o IDE web (default: true)
#   IDE_PASSWORD         <senha>     -> senha do IDE (code-server)
#   PROJECT_FOLDER       projects    -> pasta (dentro de /root) onde o Claude inicia
#   REMOTE_CONTROL_NAME  meu-servidor      -> nome anexado ao CLAUDE_AUTOCMD (ex.: /remote-control meu-servidor)
#   CLAUDE_AUTOCMD       /remote-control -> comando enviado ao Claude no start ("" desativa)
#   CLAUDE_AUTOCMD_DELAY 15          -> segundos de espera antes de enviar o comando
set -euo pipefail

U=ubuntu
H=/root                                  # home do usuario ubuntu = volume persistente
PROJECT_FOLDER="${PROJECT_FOLDER:-projects}"
PROJ="$H/$PROJECT_FOLDER"
REMOTE_CONTROL_NAME="${REMOTE_CONTROL_NAME:-}"
CLAUDE_AUTOCMD="${CLAUDE_AUTOCMD:-/remote-control}"
CLAUDE_AUTOCMD_DELAY="${CLAUDE_AUTOCMD_DELAY:-15}"
# comando final = autocmd + nome do remote-control (se definido)
#   ex.: CLAUDE_AUTOCMD="/remote-control" + REMOTE_CONTROL_NAME=meu-servidor
#        -> "/remote-control meu-servidor"
FULL_AUTOCMD="${CLAUDE_AUTOCMD}${REMOTE_CONTROL_NAME:+ ${REMOTE_CONTROL_NAME}}"

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

# Painel de controle (porta PANEL_PORT, default 7000): cadastrar pastas de projeto,
# reiniciar o Claude na pasta ativa e abrir o IDE nela. Auth = IDE_PASSWORD.
# Exponha um dominio do EasyPanel apontando para a porta do painel. PANEL_ENABLED=false desativa.
if [ "${PANEL_ENABLED:-true}" = "true" ]; then
  echo ">> painel on (${PANEL_PORT:-7000}) | projetos: $PROJECTS_DIR | log: $H/.claude/logs/panel.log"
  ( as_user env IDE_PASSWORD="${IDE_PASSWORD:-}" PANEL_PORT="${PANEL_PORT:-7000}" \
      PROJECTS_DIR="$PROJECTS_DIR" PROJECT_FOLDER="$PROJECT_FOLDER" \
      FULL_AUTOCMD="$FULL_AUTOCMD" CLAUDE_AUTOCMD_DELAY="$CLAUDE_AUTOCMD_DELAY" \
      IDE_PUBLIC_URL="${IDE_PUBLIC_URL:-}" \
      node /usr/local/bin/panel/server.js >> "$H/.claude/logs/panel.log" 2>&1 ) &
fi

# IDE (VS Code web)
if [ "${IDE_ENABLED:-true}" = "true" ]; then
  echo ">> IDE on (8080) | projeto: $PROJ | autocmd: ${CLAUDE_AUTOCMD:-<nenhum>}"
  # code-server le a var PASSWORD; mapeamos IDE_PASSWORD -> PASSWORD
  exec gosu "$U" env HOME="$H" USER="$U" PASSWORD="${IDE_PASSWORD:-}" \
    code-server --bind-addr 0.0.0.0:8080 --auth password "$PROJ"
else
  echo ">> IDE off. Console + 'tmux attach -t claude'."
  exec sleep infinity
fi
