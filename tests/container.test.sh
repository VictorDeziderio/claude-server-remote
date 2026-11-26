#!/usr/bin/env bash
# Starts the built image for real and checks that the panel answers through the gateway.
# Catches what a plain `docker build` cannot: a file the server needs at runtime missing from
# the image (e.g. src/lib/i18n-core.js and src/locales were deleted after the Vite build and the
# panel crash-looped with MODULE_NOT_FOUND while the build itself was green).
# Usage: bash tests/container.test.sh <image>   (CI runs it after building the image)
set -u
IMG="${1:?usage: tests/container.test.sh <image>}"
NAME="cr-container-test-$$"
fails=0
ok() { if [ "$2" = 0 ]; then echo "  PASS $1"; else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -e PANEL_PASSWORD=container-test-only -e BACKUP_ENABLED=false "$IMG" >/dev/null
code=000
for _ in $(seq 1 60); do
  code=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/login 2>/dev/null || echo 000)
  [ "$code" = 200 ] && break
  sleep 2
done
ok "panel answers /login through the gateway (got $code)" "$([ "$code" = 200 ] && echo 0 || echo 1)"
api=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/projects 2>/dev/null || echo 000)
ok "API asks for login (got $api)" "$([ "$api" = 401 ] && echo 0 || echo 1)"
docker exec "$NAME" test -f /usr/local/bin/panel/src/locales/en.json
ok "locale files are in the image" $?
hub=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/remote 2>/dev/null || echo 000)
ok "remote hub page is built and served (got $hub)" "$([ "$hub" = 200 ] && echo 0 || echo 1)"
hubapi=$(docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/hub-api/me 2>/dev/null || echo 000)
ok "hub API asks for a key (got $hubapi)" "$([ "$hubapi" = 401 ] && echo 0 || echo 1)"
docker exec "$NAME" sh -c 'tail -50 /root/.claude/logs/panel.log 2>/dev/null' | grep -q 'MODULE_NOT_FOUND\|exited (ran'
ok "panel did not crash-loop" "$([ $? = 0 ] && echo 1 || echo 0)"
if [ "$fails" != 0 ]; then
  echo "--- panel.log"; docker exec "$NAME" sh -c 'tail -40 /root/.claude/logs/panel.log' 2>/dev/null
fi
echo "$((6 - fails)) PASS, $fails FAIL"
[ "$fails" = 0 ]
