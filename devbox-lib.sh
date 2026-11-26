#!/usr/bin/env bash
# Shared library of the dev box (sourced by claude-session.sh / claude-loop.sh / backup.sh).
# SINGLE source of: paths, tmux session name, reading panel.json and login detection.
# Installed at /usr/local/lib/devbox/lib.sh (Dockerfile).
# shellcheck disable=SC2034  # variables (RUN_DIR, CFG_*) are used by the scripts that source this

# Full PATH even when called as a direct tmux command (minimal inherited PATH).
# Appends at the END: does not override the caller's PATH.
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"

DEVBOX_HOME="${HOME:-/root}"
PROJECTS_DIR="${PROJECTS_DIR:-$DEVBOX_HOME/projects}"
PANEL_CONFIG="${PANEL_CONFIG:-$DEVBOX_HOME/.claude/panel.json}"
RUN_DIR="$DEVBOX_HOME/.claude/run"
LOG_DIR="$DEVBOX_HOME/.claude/logs"
NODE_BIN="$(command -v node 2>/dev/null || echo /usr/bin/node)"

# tmux session name of the project: claude-<sanitized name> (tmux does not accept '.'/':').
# The same rule exists in the panel (server/util.js -> sessionName) — they must match.
sess_name() { printf 'claude-%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_')"; }

# valid project name (same rule as the panel: validName)
valid_name() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]] && [ "$1" != "." ] && [ "$1" != ".." ]; }

# Effective config of a project in panel.json (project > defaults > built-in default), as
# "key=value" lines (initLine comes out in base64 so it does not break the parsing).
#   enabled          true  -> project ON (the tmux session exists; boot/watchdog start it)
#   autoStartClaude  true  -> the session runs Claude (otherwise, only a shell)
#   autoRemote       true  -> turns /remote-control back on at each Claude start
proj_config() {  # $1 = project
  # FAIL-CLOSED (found by @qa 2026-09-28): a MISSING panel.json is normal (new project, first
  # start) -> uses the defaults (enabled=true etc). But a PRESENT panel.json with
  # CORRUPTED JSON is a real failure -> report enabled=false, NOT the defaults, otherwise a
  # project explicitly turned off (enabled=false) "comes back to life" by itself whenever the
  # file fails to parse (e.g. read in the middle of a non-atomic external write).
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [, file, proj] = process.argv; // with -e, argv[1] is already the first argument
    let c = {}, corrupt = false;
    try {
      const raw = fs.readFileSync(file, "utf8");
      try { c = JSON.parse(raw) || {}; } catch { c = {}; corrupt = true; }
    } catch { /* missing file: normal, falls back to the defaults below */ }
    if (corrupt) {
      process.stdout.write("enabled=false\nautoStartClaude=false\nautoRemote=false\ninitLine=\nsessionMode=new\npinnedSession=\naccount=default\n");
    } else {
      const d = c.defaults || {}, p = (c.projects && c.projects[proj]) || {};
      const pick = (k) => (k in p ? p[k] !== false : (k in d ? d[k] !== false : true));
      const il = typeof p.initLine === "string" ? p.initLine : "";
      // sessionMode: new (default) | continue (latest conversation of the folder) | pinned (pinnedSession)
      const sm = ["new", "continue", "pinned"].includes(p.sessionMode) ? p.sessionMode : "new";
      const ps = typeof p.pinnedSession === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(p.pinnedSession) ? p.pinnedSession : "";
      // Claude account of the project (panel -> Configure -> Account); same id rule as valid_account
      const ac = typeof p.account === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(p.account) ? p.account : "default";
      process.stdout.write(
        "enabled=" + pick("enabled") + "\nautoStartClaude=" + pick("autoStartClaude") +
        "\nautoRemote=" + pick("autoRemote") + "\ninitLine=" + Buffer.from(il).toString("base64") +
        "\nsessionMode=" + sm + "\npinnedSession=" + ps + "\naccount=" + ac + "\n");
    }
  ' "$PANEL_CONFIG" "$1" 2>/dev/null \
    || printf 'enabled=false\nautoStartClaude=false\nautoRemote=false\ninitLine=\nsessionMode=new\npinnedSession=\naccount=default\n'
}

# loads the project config into CFG_* variables (CFG_ENABLED, CFG_AUTOSTART, CFG_REMOTE, CFG_INITLINE,
# CFG_SESSMODE, CFG_PINNED, CFG_ACCOUNT)
load_proj_config() {  # $1 = project
  local line k v
  CFG_ENABLED=true CFG_AUTOSTART=true CFG_REMOTE=true CFG_INITLINE="" CFG_SESSMODE=new CFG_PINNED="" CFG_ACCOUNT=default
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      enabled) CFG_ENABLED="$v" ;;
      autoStartClaude) CFG_AUTOSTART="$v" ;;
      autoRemote) CFG_REMOTE="$v" ;;
      initLine) CFG_INITLINE="$(printf '%s' "$v" | base64 -d 2>/dev/null || true)" ;;
      sessionMode) CFG_SESSMODE="$v" ;;
      pinnedSession) CFG_PINNED="$v" ;;
      account) CFG_ACCOUNT="$v" ;;
    esac
  done < <(proj_config "$1")
}

# folder where Claude Code keeps the conversations of a directory (~/.claude/projects/<encoded cwd>):
# every character outside [A-Za-z0-9] becomes "-" (e.g. /root/projects/pilot -> -root-projects-pilot)
conv_dir() { printf '%s/.claude/projects/%s' "$DEVBOX_HOME" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"; }

# ---------------------------------------------------------------------------
# Claude accounts (chosen per project in the panel, switched by hand)
# ---------------------------------------------------------------------------
# "default" = the usual login (~/.claude + ~/.claude.json), Claude runs WITHOUT CLAUDE_CONFIG_DIR.
# Any other account = its own config dir $ACCOUNTS_DIR/<id>, given to Claude as CLAUDE_CONFIG_DIR.
# Claude Code then keeps there .credentials.json, .claude.json (oauthAccount, onboarding flags)
# and looks there for projects/, settings.json, skills/... Only the login is per account: the
# entries of ACCOUNT_SHARED are symlinks to the default ~/.claude ones, so the conversations
# (history, --continue/--resume, chat, auto-resume), settings, skills and plugins stay the same
# whatever account a project uses. Same rule in the panel (server/accounts.js calls account_prepare).
ACCOUNTS_DIR="$DEVBOX_HOME/.claude-accounts"
# dirs are created in ~/.claude when missing (so the link never dangles); files are linked only when they exist
ACCOUNT_SHARED_DIRS="projects skills agents commands plugins hooks output-styles todos plans file-history session-env"
ACCOUNT_SHARED_FILES="settings.json CLAUDE.md keybindings.json history.jsonl"
# long-lived token (claude setup-token) pasted in the panel: exported as CLAUDE_CODE_OAUTH_TOKEN
ACCOUNT_TOKEN_FILE=".oauth-token"

valid_account() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; }

# config dir of an account ("" for the default one, or for an account that no longer exists)
account_dir() {  # $1 = account id
  local id="${1:-default}"
  [ "$id" = "default" ] && return 0
  valid_account "$id" && [ -d "$ACCOUNTS_DIR/$id" ] && printf '%s' "$ACCOUNTS_DIR/$id"
  return 0
}

# Idempotent: creates the missing shared symlinks inside an account dir. Never touches an entry that
# is already a real file/dir (Claude may have created it before the link existed): nothing is lost.
account_prepare() {  # $1 = account dir
  local dir="$1" base="$DEVBOX_HOME/.claude" n
  [ -n "$dir" ] || return 0
  mkdir -p "$dir" && chmod 700 "$dir" 2>/dev/null
  for n in $ACCOUNT_SHARED_DIRS; do
    [ -e "$dir/$n" ] || [ -L "$dir/$n" ] && continue
    mkdir -p "$base/$n" 2>/dev/null && ln -s "$base/$n" "$dir/$n"
  done
  for n in $ACCOUNT_SHARED_FILES; do
    [ -e "$dir/$n" ] || [ -L "$dir/$n" ] && continue
    [ -e "$base/$n" ] && ln -s "$base/$n" "$dir/$n"
  done
  return 0
}

# true if Claude is already logged in (/login done) — in the account dir $1 ("" = default)
is_logged_in() {
  local dir="${1:-}" cj
  [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
  if [ -n "$dir" ]; then cj="$dir/.claude.json"; else dir="$DEVBOX_HOME/.claude"; cj="$DEVBOX_HOME/.claude.json"; fi
  [ -s "$dir/.credentials.json" ] && return 0
  [ -s "$dir/$ACCOUNT_TOKEN_FILE" ] && return 0
  grep -qE '"oauthAccount"|"accessToken"|"apiKey"|"primaryApiKey"' "$cj" 2>/dev/null
}

# remote-control command of the project (REMOTE_CONTROL_NAME forces one fixed name for all)
remote_cmd() { printf '/remote-control %s' "${REMOTE_CONTROL_NAME:-$1}"; }

# Alert for the panel (RUN_DIR/alerts.jsonl -> toast/notification). One JSON line per event.
# $5 (optional) = srv.* key of the text and $6.. = "name=value" variables: the panel shows the text in the
# language of whoever is looking ($4, in English, is the fallback).
alert() {  # $1=level(info|warn|error) $2=kind $3=project(or "") $4=message [$5=key [$6..=k=v]]
  mkdir -p "$RUN_DIR"
  "$NODE_BIN" -e 'const [, l, k, p, m, key, ...kv] = process.argv;
    const vars = Object.fromEntries(kv.map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)]).filter(([n]) => n));
    process.stdout.write(JSON.stringify({ t: Date.now(), level: l, kind: k, ...(p ? { project: p } : {}), msg: m, ...(key ? { key, vars } : {}) }) + "\n");' \
    "$1" "$2" "${3:-}" "$4" "${@:5}" >> "$RUN_DIR/alerts.jsonl" 2>/dev/null || true
}

# No logrotate in the image: cuts the log above ~5MB keeping the end. Truncates IN PLACE (no
# `mv`): panel.log/sessions.log are open with >> by live processes, and an mv would leave them
# writing to a deleted file that keeps taking disk space.
trim_log() {  # $1 = file
  local f="$1" tmp
  [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -gt 5242880 ] || return 0
  tmp="$(mktemp)" || return 0
  tail -n 2000 "$f" > "$tmp" && cat "$tmp" > "$f"
  rm -f "$tmp"
}

# One KEY=value line of the secrets file (start.sh) -> ENV_KEY / ENV_VAL. Never executes it.
# Forgiving with what people actually type: a trailing \r (file saved on Windows) is dropped and
# ONE pair of surrounding quotes ("x" or 'x') is removed — otherwise PANEL_PASSWORD="x" became the
# password `"x"` (quotes included) and the login silently never matched. A line with no '=' gives
# an empty ENV_KEY (ignored by the caller).
parse_env_line() {  # $1 = line
  local line="${1%$'\r'}"
  ENV_KEY="" ENV_VAL=""
  [[ "$line" == *=* ]] || return 0
  ENV_KEY="${line%%=*}"; ENV_VAL="${line#*=}"
  if [ "${#ENV_VAL}" -ge 2 ]; then
    case "$ENV_VAL" in
      \"*\"|\'*\') ENV_VAL="${ENV_VAL:1:${#ENV_VAL}-2}" ;;
    esac
  fi
}

# Exports the KNOWN keys of a secrets file (start.sh: /root/.devbox-secrets.env); anything else
# in it is ignored.
load_secrets_file() {  # $1 = file
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    parse_env_line "$line"
    case "$ENV_KEY" in
      PANEL_LOGIN|PANEL_PASSWORD|GH_TOKEN|ANTHROPIC_ADMIN_KEY|DEPLOY_WEBHOOK_URL) export "$ENV_KEY=$ENV_VAL" ;;
    esac
  done < "$1"
}

# ---------------------------------------------------------------------------
# backoff for respawn loops (claude-loop.sh, start.sh#run_bg)
# ---------------------------------------------------------------------------
# Without it, a process that crashes fast (bug, OOM) reopens every few seconds FOREVER
# -- each reopen costs CPU/memory (a new node/claude starting), and with no ceiling that
# alone overloads the machine. Usage:
#   fails=0
#   while true; do
#     t0=$(date +%s)
#     command
#     fails=$(backoff_next "$fails" "$(( $(date +%s) - t0 ))")
#     sleep "$(backoff_sleep "$fails")"
#   done
# The counter RESETS if the process ran long enough (MIN_HEALTHY_RUN_S) -- it does not confuse
# normal use (short sessions on purpose) with a real crash loop.
MIN_HEALTHY_RUN_S="${MIN_HEALTHY_RUN_S:-20}"
MAX_BACKOFF_S="${MAX_BACKOFF_S:-60}"
MAX_FAST_FAILS="${MAX_FAST_FAILS:-6}"  # from here on, the caller decides: stop trying, warn, etc.

# $1 = current fail counter, $2 = seconds the process ran -> new counter
backoff_next() {
  local fails="${1:-0}" ran="${2:-0}"
  if [ "$ran" -ge "$MIN_HEALTHY_RUN_S" ]; then echo 0; else echo "$((fails + 1))"; fi
}

# $1 = fail counter -> seconds to wait before the next restart (3,6,12,24,48,60,60...)
backoff_sleep() {
  local fails="${1:-0}" exp s
  exp="$fails"; [ "$exp" -gt 5 ] && exp=5
  s=$((3 * (1 << exp)))
  [ "$s" -gt "$MAX_BACKOFF_S" ] && s="$MAX_BACKOFF_S"
  echo "$s"
}

# Network (applies to any Docker host):
#  - TRUSTED_PROXIES empty (default): Caddy does NOT trust X-Forwarded-For coming from outside and logs
#    the real IP of the connection -> nobody bypasses the login rate limit by changing the header.
#    Behind a reverse proxy (Traefik, Nginx, Cloudflare Tunnel...), give its range,
#    e.g. TRUSTED_PROXIES="private_ranges" or "10.0.0.0/8 172.16.0.0/12".
#  - PANEL_DOMAIN set: Caddy gets an HTTPS certificate by itself (Let's Encrypt) for that
#    domain -> publish ports 80 and 443. Empty: HTTP on GATEWAY_PORT (use it behind a proxy
#    with TLS, or on a VPN/Tailscale).
#  - /healthz (Docker HEALTHCHECK) ALWAYS has a plain-HTTP site on GATEWAY_PORT, also with
#    PANEL_DOMAIN (otherwise nothing listens there and the container is unhealthy forever). In
#    domain mode that extra site answers ONLY /healthz: the panel is never served without TLS.
#  - /healthz is proxied to the panel's own /healthz (a tiny route, no auth): a crashed or hung
#    panel makes the healthcheck fail, instead of Caddy always answering "ok". With
#    PANEL_ENABLED=false there is no panel to ask, so Caddy answers it itself.
write_caddyfile() {  # $1 = path of the Caddyfile; uses GATEWAY_PORT, PANEL_PORT, TRUSTED_PROXIES, PANEL_DOMAIN, PANEL_ENABLED
  local CADDY_TRUST CADDY_HTTPS CADDY_HEALTH
  if [ -n "${TRUSTED_PROXIES:-}" ]; then
    CADDY_TRUST="	servers {
		trusted_proxies static ${TRUSTED_PROXIES}
	}"
  else
    CADDY_TRUST=""
  fi
  if [ "${PANEL_ENABLED:-true}" = "false" ]; then
    CADDY_HEALTH='respond "ok" 200'
  else
    CADDY_HEALTH="reverse_proxy 127.0.0.1:${PANEL_PORT}"
  fi
  if [ -n "${PANEL_DOMAIN:-}" ]; then CADDY_HTTPS=""; else CADDY_HTTPS="	auto_https off"; fi
  {
    cat <<CADDY
{
${CADDY_HTTPS}
	admin off
${CADDY_TRUST}
}
${PANEL_DOMAIN:-:${GATEWAY_PORT}} {
	route {
		handle /healthz {
			${CADDY_HEALTH}
		}
		reverse_proxy 127.0.0.1:${PANEL_PORT}
	}
}
CADDY
    # domain mode: health-only HTTP site on GATEWAY_PORT (80/443 are already the domain's own)
    if [ -n "${PANEL_DOMAIN:-}" ] && [ "${GATEWAY_PORT}" != 80 ] && [ "${GATEWAY_PORT}" != 443 ]; then
      cat <<CADDY
http://:${GATEWAY_PORT} {
	handle /healthz {
		${CADDY_HEALTH}
	}
	respond 404
}
CADDY
    fi
  } > "$1"
}
