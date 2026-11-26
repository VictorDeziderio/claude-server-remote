#!/usr/bin/env bash
# Test of the git project backup (backup.sh with no args / backup.sh <repo>) against a temp repo
# with a local BARE remote, plus the per-kind locks. Nothing real is touched.
# Usage: bash tests/backup-git.test.sh
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
H="$T/home"; P="$H/projects"; R="$T/remote.git"; A="$P/app"
LOCKPIDS=()
cleanup() { for p in "${LOCKPIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
fails=0; passes=0
ok() { if [ "$2" = 0 ]; then echo "  PASS $1"; passes=$((passes + 1)); else echo "  FAIL $1 ${3:-}"; fails=$((fails + 1)); fi; }
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.name test; git config --file "$GIT_CONFIG_GLOBAL" user.email test@localhost
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
run() { HOME="$H" PROJECTS_DIR="$P" DEVBOX_LIB=/nonexistent bash "$DIR/backup.sh" "$@" 2>&1; }
remote_count() { git -C "$R" rev-list --count main 2>/dev/null || echo 0; }
in_remote() { git -C "$R" ls-tree -r --name-only main | grep -qx "$1"; }
LOG="$H/.claude/logs/backup.log"

mkdir -p "$P"
git init -q --bare "$R"
git clone -q "$R" "$A" 2>/dev/null
echo one > "$A/a.txt"; git -C "$A" add a.txt; git -C "$A" commit -qm init; git -C "$A" push -q -u origin main 2>/dev/null

echo "== normal snapshot"
echo two > "$A/a.txt"; mkdir -p "$A/src"; echo code > "$A/src/b.js"
out="$(run)"; ok "run succeeds" $? "$out"
ok "snapshot pushed to the remote" "$([ "$(remote_count)" = 2 ] && in_remote src/b.js && echo 0 || echo 1)"
grep -q 'ok    app: snapshot pushed' "$LOG"; ok "logs 'ok    app: snapshot pushed'" $?
ok "pushes the current branch (main) — unchanged behaviour" "$([ "$(git -C "$A" rev-parse HEAD)" = "$(git -C "$R" rev-parse main)" ] && echo 0 || echo 1)"

echo "== chat/terminal uploads and the worklog are never committed"
mkdir -p "$A/.chat-uploads/2026-11" "$A/sub/.chat-uploads/2026-11" "$A/docs/worklog"
echo img > "$A/.chat-uploads/2026-11/abcd1234-photo.png"; echo log > "$A/sub/.chat-uploads/2026-11/x.log"
echo w > "$A/docs/worklog/today.md"; echo three > "$A/a.txt"
git -C "$A" add -f .chat-uploads   # staged earlier by someone: still left out
run >/dev/null
ok "the other change is pushed" "$([ "$(remote_count)" = 3 ] && echo 0 || echo 1)"
! in_remote .chat-uploads/2026-11/abcd1234-photo.png && ! in_remote sub/.chat-uploads/2026-11/x.log
ok ".chat-uploads/ (any depth, even if pre-staged) is not committed" $?
! in_remote docs/worklog/today.md; ok "docs/worklog is not committed" $?
ok "the uploads are still on disk, untouched" "$([ -f "$A/.chat-uploads/2026-11/abcd1234-photo.png" ] && echo 0 || echo 1)"
before="$(remote_count)"; run >/dev/null
ok "only uploads changed -> no empty commit" "$([ "$(remote_count)" = "$before" ] && echo 0 || echo 1)"

echo "== merge in progress -> skip"
git -C "$A" checkout -q -b other; echo other > "$A/a.txt"; git -C "$A" commit -qam other
git -C "$A" checkout -q main; echo mine > "$A/a.txt"; git -C "$A" commit -qam mine
git -C "$A" merge other >/dev/null 2>&1
ok "(setup) merge is in conflict" "$([ -e "$A/.git/MERGE_HEAD" ] && echo 0 || echo 1)"
head="$(git -C "$A" rev-parse HEAD)"
out="$(run "$A")"
ok "no commit during the merge" "$([ "$(git -C "$A" rev-parse HEAD)" = "$head" ] && [ -e "$A/.git/MERGE_HEAD" ] && echo 0 || echo 1)"
grep -q "skip  app: a git operation is in progress (MERGE_HEAD)" "$LOG"; ok "logs why it skipped (merge)" $? "$out"
git -C "$A" merge --abort

echo "== cherry-pick / rebase in progress -> skip"
git -C "$A" cherry-pick other >/dev/null 2>&1
head="$(git -C "$A" rev-parse HEAD)"; run >/dev/null
ok "no commit during a cherry-pick" "$([ "$(git -C "$A" rev-parse HEAD)" = "$head" ] && grep -q '(CHERRY_PICK_HEAD)' "$LOG" && echo 0 || echo 1)"
git -C "$A" cherry-pick --abort
git -C "$A" checkout -q other; git -C "$A" rebase main >/dev/null 2>&1
ok "(setup) rebase is in conflict" "$([ -d "$A/.git/rebase-merge" ] || [ -d "$A/.git/rebase-apply" ] && echo 0 || echo 1)"
head="$(git -C "$A" rev-parse HEAD)"; run >/dev/null
ok "no commit during a rebase" "$([ "$(git -C "$A" rev-parse HEAD)" = "$head" ] && grep -qE '\(rebase-(merge|apply)\)' "$LOG" && echo 0 || echo 1)"
git -C "$A" rebase --abort; git -C "$A" checkout -q main

echo "== detached HEAD -> skip"
git -C "$A" checkout -q --detach; echo detached > "$A/a.txt"
head="$(git -C "$A" rev-parse HEAD)"; run >/dev/null
ok "no commit on a detached HEAD" "$([ "$(git -C "$A" rev-parse HEAD)" = "$head" ] && echo 0 || echo 1)"
grep -q "skip  app: detached HEAD" "$LOG"; ok "logs why it skipped (detached HEAD)" $?
git -C "$A" checkout -q main 2>/dev/null || { git -C "$A" checkout -q -- a.txt; git -C "$A" checkout -q main; }

echo "== one lock per kind"
hold() {  # $1 = kind: holds its lock in the background until killed
  # `exec sleep`: the PID we kill is the one holding the lock (a child would keep it held)
  ( exec 8>"$H/.claude/logs/backup-$1.lock"; flock 8; exec sleep 30 ) & LOCKPIDS+=($!)
  for _ in $(seq 40); do flock -n "$H/.claude/logs/backup-$1.lock" true || return 0; sleep 0.05; done
}
hold volume
echo four > "$A/a.txt"; before="$(remote_count)"
out="$(run)"
ok "a running volume backup does NOT block the hourly git backup" "$([ "$(remote_count)" -gt "$before" ] && echo 0 || echo 1)" "$out"
hold projects
echo five > "$A/a.txt"; before="$(remote_count)"
out="$(run "$A")"; rc=$?
ok "a second projects backup while one runs is skipped (exit 0, nothing pushed)" "$([ "$rc" = 0 ] && [ "$(remote_count)" = "$before" ] && echo 0 || echo 1)"
echo "$out" | grep -q 'skip  (projects): another projects backup is still running'; ok "the skip is printed (\"backup now\" shows it)" $? "$out"
grep -q 'skip  (projects): another projects backup is still running' "$LOG"; ok "the skip is in backup.log" $?
out="$(run --config)"
ok "config backup still runs while projects is locked" "$(ls "$H"/.claude-backups/config-*.tgz >/dev/null 2>&1 && echo 0 || echo 1)" "$out"
for p in "${LOCKPIDS[@]}"; do kill "$p" 2>/dev/null; done; LOCKPIDS=()

echo "== repo without origin"
mkdir -p "$P/local"; git -C "$P/local" init -q; echo x > "$P/local/f"
run >/dev/null; grep -q "skip  local: no 'origin' remote" "$LOG"; ok "skips a repo with no origin (logged)" $?

echo "$passes PASS, $fails FAIL"
[ "$fails" = 0 ]
