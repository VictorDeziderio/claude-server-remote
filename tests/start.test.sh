#!/usr/bin/env bash
# shellcheck disable=SC2016  # the single-quoted $... are literal text searched for in the scripts
# Tests of the start.sh helpers that can run outside the container: the secrets file reader
# (devbox-lib.sh#load_secrets_file), log trimming (which logs the watchdog trims) and defaults
# that must match the Dockerfile / panel config. Usage: bash tests/start.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export HOME="$T"
# shellcheck source=devbox-lib.sh
. "$HERE/devbox-lib.sh"
fails=0; passes=0
ok() { if [ "$2" = 0 ]; then echo "  PASS $1"; passes=$((passes + 1)); else echo "  FAIL $1 ${3:-}"; fails=$((fails + 1)); fi; }

echo "== secrets file reader"
unset PANEL_LOGIN PANEL_PASSWORD GH_TOKEN ANTHROPIC_ADMIN_KEY DEPLOY_WEBHOOK_URL NOT_ALLOWED
printf '%s\n' \
  '# a comment' \
  'PANEL_PASSWORD="dq secret"' \
  "PANEL_LOGIN='sq-login'" \
  'GH_TOKEN=plain=with=equals' \
  'NOT_ALLOWED=x' \
  'just a line without equals' > "$T/s1.env"
printf 'ANTHROPIC_ADMIN_KEY="crlf-key"\r\nDEPLOY_WEBHOOK_URL=http://hook.example/x\r\n' > "$T/s2.env"
load_secrets_file "$T/s1.env"; load_secrets_file "$T/s2.env"
[ "${PANEL_PASSWORD:-}" = "dq secret" ]; ok 'double quotes are stripped (PANEL_PASSWORD="x" -> x)' $? "(got: ${PANEL_PASSWORD:-})"
[ "${PANEL_LOGIN:-}" = "sq-login" ]; ok "single quotes are stripped" $? "(got: ${PANEL_LOGIN:-})"
[ "${GH_TOKEN:-}" = "plain=with=equals" ]; ok "unquoted value with '=' kept whole" $? "(got: ${GH_TOKEN:-})"
[ "${ANTHROPIC_ADMIN_KEY:-}" = "crlf-key" ]; ok "trailing \\r (Windows line ends) is dropped, then the quotes" $? "(got: $(printf '%q' "${ANTHROPIC_ADMIN_KEY:-}"))"
[ "${DEPLOY_WEBHOOK_URL:-}" = "http://hook.example/x" ]; ok "trailing \\r dropped on unquoted values" $? "(got: $(printf '%q' "${DEPLOY_WEBHOOK_URL:-}"))"
[ -z "${NOT_ALLOWED:-}" ]; ok "unknown keys are ignored" $?
printf 'PANEL_PASSWORD="half\nPANEL_LOGIN=a"b"\n' > "$T/s3.env"; load_secrets_file "$T/s3.env"
[ "${PANEL_PASSWORD:-}" = '"half' ] && [ "${PANEL_LOGIN:-}" = 'a"b"' ]; ok "unbalanced / inner quotes are left as typed" $?
printf 'PANEL_PASSWORD=x' > "$T/s4.env"; load_secrets_file "$T/s4.env"
[ "${PANEL_PASSWORD:-}" = x ]; ok "last line without a newline is read" $?
grep -q 'load_secrets_file "$SECRETS_FILE"' "$HERE/start.sh"; ok "start.sh uses load_secrets_file" $?
grep -q 'SECRETS_FILE="$H/.devbox-secrets.env"' "$HERE/start.sh" && grep -q '/root/.devbox-secrets.env' "$HERE/README.md"
ok "secrets file path in start.sh is the one the README documents" $?

echo "== log trimming"
loop="$(grep -n 'do trim_log' "$HERE/start.sh")"
for f in panel.log sessions.log backup.log audit.log '$ALERTS'; do
  echo "$loop" | grep -qF "$f"; ok "the watchdog trims $f" $?
done
yes 'line of the audit log ......................................................' | head -n 80000 > "$T/audit.log"
trim_log "$T/audit.log"
n="$(wc -l < "$T/audit.log")"; [ "$n" = 2000 ]; ok "trim_log keeps the last 2000 lines of a >5MB log ($n)" $?

echo "== defaults match"
grep -q 'PANEL_SESSION_DAYS="${PANEL_SESSION_DAYS:-365}"' "$HERE/start.sh" \
  && grep -q 'PANEL_SESSION_DAYS=365' "$HERE/Dockerfile" \
  && grep -q "PANEL_SESSION_DAYS || '365'" "$HERE/panel/server/config.js"
ok "PANEL_SESSION_DAYS default is 365 in start.sh, Dockerfile and config.js" $?

echo "$passes PASS, $fails FAIL"
[ "$fails" = 0 ]
