#!/usr/bin/env bash
# Test of `backup.sh --volume` (incremental copies of the home with rsync --link-dest).
# Usage: bash tests/backup-volume.test.sh
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
H="$T/home"; B="$T/backups"
fails=0; passes=0
ok() { if [ "$2" = 0 ]; then echo "  PASS $1"; passes=$((passes + 1)); else echo "  FAIL $1"; fails=$((fails + 1)); fi; }
run() { HOME="$H" VOLUME_BACKUP_DIR="$B" VOLUME_BACKUP_KEEP="${KEEP:-7}" VOLUME_BACKUP_EXCLUDE="${EXTRA:-}" DEVBOX_LIB=/nonexistent bash "$DIR/backup.sh" --volume >/dev/null 2>&1; }
inode() { stat -c %i "$1"; }

mkdir -p "$H/projects/app/src" "$H/projects/app/node_modules/x" "$H/projects/app/.claude/worktrees/agent-1" "$H/.cache/big" "$H/.claude/projects" "$H/.claude-backups" "$H/projects/app/tmp-big"
echo keep > "$H/projects/app/src/a.txt"; echo same > "$H/projects/app/src/same.txt"
echo dep > "$H/projects/app/node_modules/x/i.js"; echo wt > "$H/projects/app/.claude/worktrees/agent-1/f"
echo c > "$H/.cache/big/f"; echo conv > "$H/.claude/projects/c.jsonl"; echo t > "$H/.claude-backups/config.tgz"; echo big > "$H/projects/app/tmp-big/f"

EXTRA="projects/app/tmp-big/" run; ok "first copy succeeds" $?
S1="$(readlink "$B/latest")"
ok "copy is a complete folder with the files" "$([ -f "$B/$S1/projects/app/src/a.txt" ] && [ -f "$B/$S1/.claude/projects/c.jsonl" ] && echo 0 || echo 1)"
ok "skips node_modules, caches, agent work copies, config tarballs" "$([ ! -e "$B/$S1/projects/app/node_modules" ] && [ ! -e "$B/$S1/.cache" ] && [ ! -e "$B/$S1/projects/app/.claude/worktrees" ] && [ ! -e "$B/$S1/.claude-backups" ] && echo 0 || echo 1)"
ok "VOLUME_BACKUP_EXCLUDE adds more" "$([ ! -e "$B/$S1/projects/app/tmp-big" ] && echo 0 || echo 1)"

sleep 1.1
echo changed > "$H/projects/app/src/a.txt"; rm "$H/projects/app/src/same.txt.gone" 2>/dev/null; echo new > "$H/projects/app/src/new.txt"; rm "$H/.claude/projects/c.jsonl"
EXTRA="projects/app/tmp-big/" run; ok "second copy succeeds" $?
S2="$(readlink "$B/latest")"
ok "latest points to the new copy" "$([ "$S2" != "$S1" ] && echo 0 || echo 1)"
ok "unchanged file is shared (hard link, no extra space)" "$([ "$(inode "$B/$S1/projects/app/src/same.txt")" = "$(inode "$B/$S2/projects/app/src/same.txt")" ] && echo 0 || echo 1)"
ok "changed file has its new content; the old copy keeps the old one" "$([ "$(cat "$B/$S2/projects/app/src/a.txt")" = changed ] && [ "$(cat "$B/$S1/projects/app/src/a.txt")" = keep ] && echo 0 || echo 1)"
ok "deleted file: gone from the new copy, still in the old one" "$([ ! -e "$B/$S2/.claude/projects/c.jsonl" ] && [ -f "$B/$S1/.claude/projects/c.jsonl" ] && echo 0 || echo 1)"

for _ in 1 2 3; do sleep 1.1; KEEP=2 run; done
n="$(find "$B" -mindepth 1 -maxdepth 1 -type d -name '20*' | wc -l)"
ok "keeps only the newest VOLUME_BACKUP_KEEP copies (2, got $n)" "$([ "$n" = 2 ] && echo 0 || echo 1)"
ok "no .partial left behind" "$([ -z "$(find "$B" -maxdepth 1 -name '*.partial')" ] && echo 0 || echo 1)"

HOME="$H" VOLUME_BACKUP_DIR="$H/inside" DEVBOX_LIB=/nonexistent bash "$DIR/backup.sh" --volume >/dev/null 2>&1
ok "refuses a destination inside the volume itself" "$([ $? != 0 ] && [ ! -e "$H/inside/latest" ] && echo 0 || echo 1)"
HOME="$H" VOLUME_BACKUP_DIR="" DEVBOX_LIB=/nonexistent bash "$DIR/backup.sh" --volume >/dev/null 2>&1
ok "not configured -> does nothing, no error" $?
grep -q "ok    (volume):" "$H/.claude/logs/backup.log"; ok "result goes to backup.log (shown in the panel)" $?

echo "$passes PASS, $fails FAIL"
[ "$fails" = 0 ]
