#!/usr/bin/env bash
# Repo hygiene: every tracked file has a sane name (no quotes, pipes, spaces or control chars —
# usually the leftover of a broken shell redirect) and no hosting-platform name leaks into code.
set -u
cd "$(dirname "$0")/.." || exit 1
fails=0; passes=0
ok() { if [ "$2" = 0 ]; then echo "  PASS $1"; passes=$((passes + 1)); else echo "  FAIL $1 ${3:-}"; fails=$((fails + 1)); fi; }
bad="$(git ls-files -z | tr '\0' '\n' | grep -vE '^[A-Za-z0-9._/@+-]+$' || true)"
ok "tracked file names are sane" "$([ -z "$bad" ] && echo 0 || echo 1)" "$bad"
leak="$(git grep -nIi 'easypanel' -- . ':!README*' ':!tests/repo-hygiene.test.sh' || true)"
ok "no hosting-platform name in code" "$([ -z "$leak" ] && echo 0 || echo 1)" "$leak"
echo "$passes PASS, $fails FAIL"
[ "$fails" = 0 ]
