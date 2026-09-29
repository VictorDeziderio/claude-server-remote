#!/usr/bin/env bash
# Biblioteca comum do dev-box (sourced por claude-session.sh / claude-loop.sh / backup.sh).
# Fonte UNICA de: caminhos, nome da sessao tmux, leitura do panel.json e deteccao de login.
# Instalada em /usr/local/lib/devbox/lib.sh (Dockerfile).
# shellcheck disable=SC2034  # variaveis (RUN_DIR, CFG_*) sao usadas pelos scripts que fazem source

# PATH completo mesmo quando chamado como comando direto do tmux (PATH herdado minimo).
# Acrescenta no FIM: nao passa por cima do PATH de quem chamou.
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"

DEVBOX_HOME="${HOME:-/root}"
PROJECTS_DIR="${PROJECTS_DIR:-$DEVBOX_HOME/projects}"
PANEL_CONFIG="${PANEL_CONFIG:-$DEVBOX_HOME/.claude/panel.json}"
RUN_DIR="$DEVBOX_HOME/.claude/run"
LOG_DIR="$DEVBOX_HOME/.claude/logs"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/bin/node)"

# nome da sessao tmux do projeto: claude-<nome sanitizado> (tmux nao aceita '.'/':').
# A mesma regra existe no painel (server/util.js -> sessionName) — tem de bater.
sess_name() { printf 'claude-%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_')"; }

# nome de projeto valido (mesma regra do painel: validName)
valid_name() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]] && [ "$1" != "." ] && [ "$1" != ".." ]; }

# Config efetiva de um projeto no panel.json (projeto > defaults > padrao embutido), em
# formato "chave=valor" por linha (initLine sai em base64 p/ nao quebrar o parse).
#   enabled          true  -> projeto LIGADO (sessao tmux existe; boot/watchdog sobem)
#   autoStartClaude  true  -> a sessao roda o Claude (senao, so um shell)
#   autoRemote       true  -> religa o /remote-control a cada inicio do Claude
proj_config() {  # $1 = projeto
  # FAIL-CLOSED (achado @qa 2026-09-28): panel.json AUSENTE e' normal (projeto novo, 1a
  # subida) -> usa os defaults (enabled=true etc). Ja panel.json PRESENTE mas com JSON
  # CORROMPIDO e' uma falha real -> reportar enabled=false, e NAO os defaults, senao um
  # projeto explicitamente desligado (enabled=false) "renasce" sozinho sempre que o
  # arquivo falhar em parsear (ex.: leitura no meio de uma escrita nao-atomica externa).
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [, file, proj] = process.argv; // com -e, argv[1] ja e o 1o argumento
    let c = {}, corrupt = false;
    try {
      const raw = fs.readFileSync(file, "utf8");
      try { c = JSON.parse(raw) || {}; } catch { c = {}; corrupt = true; }
    } catch { /* arquivo ausente: normal, cai nos defaults abaixo */ }
    if (corrupt) {
      process.stdout.write("enabled=false\nautoStartClaude=false\nautoRemote=false\ninitLine=\n");
    } else {
      const d = c.defaults || {}, p = (c.projects && c.projects[proj]) || {};
      const pick = (k) => (k in p ? p[k] !== false : (k in d ? d[k] !== false : true));
      const il = typeof p.initLine === "string" ? p.initLine : "";
      process.stdout.write(
        "enabled=" + pick("enabled") + "\nautoStartClaude=" + pick("autoStartClaude") +
        "\nautoRemote=" + pick("autoRemote") + "\ninitLine=" + Buffer.from(il).toString("base64") + "\n");
    }
  ' "$PANEL_CONFIG" "$1" 2>/dev/null \
    || printf 'enabled=false\nautoStartClaude=false\nautoRemote=false\ninitLine=\n'
}

# carrega a config do projeto em variaveis CFG_* (CFG_ENABLED, CFG_AUTOSTART, CFG_REMOTE, CFG_INITLINE)
load_proj_config() {  # $1 = projeto
  local line k v
  CFG_ENABLED=true CFG_AUTOSTART=true CFG_REMOTE=true CFG_INITLINE=""
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      enabled) CFG_ENABLED="$v" ;;
      autoStartClaude) CFG_AUTOSTART="$v" ;;
      autoRemote) CFG_REMOTE="$v" ;;
      initLine) CFG_INITLINE="$(printf '%s' "$v" | base64 -d 2>/dev/null || true)" ;;
    esac
  done < <(proj_config "$1")
}

# verdadeiro se o Claude ja estiver logado (/login feito)
is_logged_in() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -s "$DEVBOX_HOME/.claude/.credentials.json" ] && return 0
  grep -qE '"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"' "$DEVBOX_HOME/.claude.json" 2>/dev/null
}

# comando do remote-control do projeto (REMOTE_CONTROL_NAME forca um nome fixo p/ todos)
remote_cmd() { printf '/remote-control %s' "${REMOTE_CONTROL_NAME:-$1}"; }
