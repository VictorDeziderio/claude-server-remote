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
      process.stdout.write("enabled=false\nautoStartClaude=false\nautoRemote=false\ninitLine=\nsessionMode=new\npinnedSession=\n");
    } else {
      const d = c.defaults || {}, p = (c.projects && c.projects[proj]) || {};
      const pick = (k) => (k in p ? p[k] !== false : (k in d ? d[k] !== false : true));
      const il = typeof p.initLine === "string" ? p.initLine : "";
      // sessionMode: new (padrao) | continue (ultima conversa da pasta) | pinned (pinnedSession)
      const sm = ["new", "continue", "pinned"].includes(p.sessionMode) ? p.sessionMode : "new";
      const ps = typeof p.pinnedSession === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(p.pinnedSession) ? p.pinnedSession : "";
      process.stdout.write(
        "enabled=" + pick("enabled") + "\nautoStartClaude=" + pick("autoStartClaude") +
        "\nautoRemote=" + pick("autoRemote") + "\ninitLine=" + Buffer.from(il).toString("base64") +
        "\nsessionMode=" + sm + "\npinnedSession=" + ps + "\n");
    }
  ' "$PANEL_CONFIG" "$1" 2>/dev/null \
    || printf 'enabled=false\nautoStartClaude=false\nautoRemote=false\ninitLine=\nsessionMode=new\npinnedSession=\n'
}

# carrega a config do projeto em variaveis CFG_* (CFG_ENABLED, CFG_AUTOSTART, CFG_REMOTE, CFG_INITLINE)
load_proj_config() {  # $1 = projeto
  local line k v
  CFG_ENABLED=true CFG_AUTOSTART=true CFG_REMOTE=true CFG_INITLINE="" CFG_SESSMODE=new CFG_PINNED=""
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      enabled) CFG_ENABLED="$v" ;;
      autoStartClaude) CFG_AUTOSTART="$v" ;;
      autoRemote) CFG_REMOTE="$v" ;;
      initLine) CFG_INITLINE="$(printf '%s' "$v" | base64 -d 2>/dev/null || true)" ;;
      sessionMode) CFG_SESSMODE="$v" ;;
      pinnedSession) CFG_PINNED="$v" ;;
    esac
  done < <(proj_config "$1")
}

# pasta onde o Claude Code guarda as conversas de um diretorio (~/.claude/projects/<cwd codificado>):
# todo caractere fora de [A-Za-z0-9] vira "-" (ex.: /root/projects/pilot -> -root-projects-pilot)
conv_dir() { printf '%s/.claude/projects/%s' "$DEVBOX_HOME" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"; }

# verdadeiro se o Claude ja estiver logado (/login feito)
is_logged_in() {
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  [ -s "$DEVBOX_HOME/.claude/.credentials.json" ] && return 0
  grep -qE '"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"' "$DEVBOX_HOME/.claude.json" 2>/dev/null
}

# comando do remote-control do projeto (REMOTE_CONTROL_NAME forca um nome fixo p/ todos)
remote_cmd() { printf '/remote-control %s' "${REMOTE_CONTROL_NAME:-$1}"; }

# Alerta p/ o painel (RUN_DIR/alerts.jsonl -> toast/notificacao). Uma linha JSON por evento.
alert() {  # $1=level(info|warn|error) $2=kind $3=projeto(ou "") $4=mensagem
  mkdir -p "$RUN_DIR"
  "$NODE_BIN" -e 'const [, l, k, p, m] = process.argv;
    process.stdout.write(JSON.stringify({ t: Date.now(), level: l, kind: k, ...(p ? { project: p } : {}), msg: m }) + "\n");' \
    "$1" "$2" "${3:-}" "$4" >> "$RUN_DIR/alerts.jsonl" 2>/dev/null || true
}

# Sem logrotate na imagem: corta o log acima de ~5MB mantendo o final. Trunca NO LUGAR (nao
# `mv`): panel.log/sessions.log estao abertos com >> por processos vivos, e um mv os deixaria
# escrevendo num arquivo apagado que continua ocupando disco.
trim_log() {  # $1 = arquivo
  local f="$1" tmp
  [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -gt 5242880 ] || return 0
  tmp="$(mktemp)" || return 0
  tail -n 2000 "$f" > "$tmp" && cat "$tmp" > "$f"
  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# backoff p/ loops de respawn (claude-loop.sh, start.sh#run_bg)
# ---------------------------------------------------------------------------
# Sem isso, um processo que crasha rapido (bug, OOM) reabre a cada poucos segundos PRA SEMPRE
# -- cada reabertura tem custo de CPU/memoria (novo node/claude subindo), e sem teto isso
# sozinho ja sobrecarrega a VM. Uso:
#   fails=0
#   while true; do
#     t0=$(date +%s)
#     comando
#     fails=$(backoff_next "$fails" "$(( $(date +%s) - t0 ))")
#     sleep "$(backoff_sleep "$fails")"
#   done
# O contador ZERA se o processo rodou tempo o bastante (MIN_HEALTHY_RUN_S) -- nao confunde
# uso normal (sessoes curtas de proposito) com crash-loop real.
MIN_HEALTHY_RUN_S="${MIN_HEALTHY_RUN_S:-20}"
MAX_BACKOFF_S="${MAX_BACKOFF_S:-60}"
MAX_FAST_FAILS="${MAX_FAST_FAILS:-6}"  # a partir daqui, quem chama decide: parar de tentar, avisar, etc.

# $1 = contador atual de fails, $2 = segundos que o processo rodou -> novo contador
backoff_next() {
  local fails="${1:-0}" ran="${2:-0}"
  if [ "$ran" -ge "$MIN_HEALTHY_RUN_S" ]; then echo 0; else echo "$((fails + 1))"; fi
}

# $1 = contador de fails -> segundos de espera antes do proximo restart (3,6,12,24,48,60,60...)
backoff_sleep() {
  local fails="${1:-0}" exp s
  exp="$fails"; [ "$exp" -gt 5 ] && exp=5
  s=$((3 * (1 << exp)))
  [ "$s" -gt "$MAX_BACKOFF_S" ] && s="$MAX_BACKOFF_S"
  echo "$s"
}

# Rede (vale para qualquer host Docker):
#  - TRUSTED_PROXIES vazio (padrao): o Caddy NAO confia em X-Forwarded-For vindo de fora e grava
#    o IP real da conexao -> ninguem burla o rate-limit do login trocando o header.
#    Atras de um proxy reverso (Traefik, Nginx, Cloudflare Tunnel...), informe a faixa dele,
#    ex.: TRUSTED_PROXIES="private_ranges" ou "10.0.0.0/8 172.16.0.0/12".
#  - PANEL_DOMAIN definido: o Caddy tira certificado HTTPS sozinho (Let's Encrypt) para esse
#    dominio -> publique as portas 80 e 443. Vazio: HTTP em GATEWAY_PORT (use atras de um proxy
#    com TLS, ou numa VPN/Tailscale).
write_caddyfile() {  # $1 = caminho do Caddyfile; usa GATEWAY_PORT, PANEL_PORT, TRUSTED_PROXIES, PANEL_DOMAIN
  local CADDY_TRUST CADDY_HTTPS CADDY_SITE
if [ -n "${TRUSTED_PROXIES:-}" ]; then
  CADDY_TRUST="	servers {
		trusted_proxies static ${TRUSTED_PROXIES}
	}"
else
  CADDY_TRUST=""
fi
if [ -n "${PANEL_DOMAIN:-}" ]; then
  CADDY_HTTPS=""; CADDY_SITE="${PANEL_DOMAIN}"
else
  CADDY_HTTPS="	auto_https off"; CADDY_SITE=":${GATEWAY_PORT}"
fi
cat > "$1" <<CADDY
{
${CADDY_HTTPS}
	admin off
${CADDY_TRUST}
}
${CADDY_SITE} {
	route {
		@health path /healthz
		respond @health "ok" 200
		reverse_proxy 127.0.0.1:${PANEL_PORT}
	}
}
CADDY
}
