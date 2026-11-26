#!/usr/bin/env bash
# Automatic project backup: goes through each git repo inside
# $PROJECTS_DIR and does add + commit (if something changed) + push (best effort). Repos without
# an 'origin' remote are skipped (with a note in the log). Push authentication uses
# the gh/GH_TOKEN set up in start.sh (gh auth setup-git).
#
# Usage:
#   backup.sh            -> one pass over ALL projects in $PROJECTS_DIR
#   backup.sh /path      -> backup of that repo only
#   backup.sh --config   -> tarball of the CONFIG (~/.claude without history/logs + ~/.claude.json)
#                           in $H/.claude-backups/config-<date>.tgz (keeps the 7 newest).
#                           Download it in the panel (Backup) — if the volume goes away, login/config go with it.
#   backup.sh --volume   -> incremental copy of the whole home (/root, the volume) into
#                           $VOLUME_BACKUP_DIR/<date>/ — a folder on ANOTHER disk or mount.
#                           rsync --link-dest: files that did not change are hard links to the
#                           previous copy, so each new copy only takes the space of what changed,
#                           and every copy is still a complete, browsable folder. Keeps the
#                           newest $VOLUME_BACKUP_KEEP (7). Skips rebuildable data: node_modules,
#                           caches (.cache .npm .gradle .bun), agent work copies (.claude/worktrees)
#                           and the config tarballs; add more with VOLUME_BACKUP_EXCLUDE (comma list).
#
# Runs as the "ubuntu" user (HOME=/root, volume). The git identity is set
# in start.sh (or falls back to a local default here).
set -uo pipefail   # no -e: one repo that fails does not abort the others

H="${HOME:-/root}"
# the SAME projects folder as the panel/sessions (it used to use /root/$PROJECT_FOLDER, which only
# matched the default; with PROJECT_FOLDER=other the backup scanned the wrong folder)
PROJECTS_DIR="${PROJECTS_DIR:-$H/projects}"
LOG_DIR="$H/.claude/logs"
LOG="$LOG_DIR/backup.log"
CFG_BACKUP_DIR="$H/.claude-backups"
CFG_KEEP="${CONFIG_BACKUP_KEEP:-7}"
mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%F %T')] $*" | tee -a "$LOG"
  # no logrotate in this dev box: backup.log grows forever and would grow with no ceiling until
  # the disk ran out. Truncates itself above ~5MB, keeping only the end (found by @qa).
  if [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# Two calls of the SAME kind at the same time (automatic loop + "backup now" in the panel) would
# run git add/commit/push on the same repo in parallel -> race on the git index. Non-blocking
# lock: if a backup of that kind is already running, skip this pass (it comes back on the next
# interval/click) instead of piling up.
# ONE LOCK PER KIND (projects / config / volume): they touch different things, and with a single
# shared lock the long volume rsync (can take hours) silently blocked the hourly git backups and
# the "backup now" button. A skipped run is logged as "skip  (<kind>): ..." (backup.log, shown in
# the panel's Logs) and printed, so the "backup now" button shows it too.
case "${1:-}" in
  --config) KIND=config ;;
  --volume) KIND=volume ;;
  *) KIND=projects ;;
esac
exec 9>"$LOG_DIR/backup-$KIND.lock"
if ! flock -n 9; then
  log "skip  ($KIND): another $KIND backup is still running — this run was skipped"
  exit 0
fi

# alert() and RUN_DIR come from the shared lib; without it (test outside the image) alerts just do not go out
# shellcheck source=devbox-lib.sh
. "${DEVBOX_LIB:-/usr/local/lib/devbox/lib.sh}" 2>/dev/null || alert() { :; }
# machine memory at the limit (start.sh guard): tar/git now would only make it worse -- skip this pass
if [ -e "${RUN_DIR:-$H/.claude/run}/lowmem" ]; then
  log "skip: memory is high (lowmem) — backup postponed"
  exit 0
fi

backup_config() {
  mkdir -p "$CFG_BACKUP_DIR"
  local out stamp
  # +PID: two runs in the same second (automatic job + manual click) do not collide
  # on the file name and one does not silently overwrite the other (found by @qa 2026-09-28)
  stamp="$(date '+%Y%m%d-%H%M%S')-$$"
  out="$CFG_BACKUP_DIR/config-$stamp.tgz"
  if tar czf "$out" -C "$H" --ignore-failed-read \
       --exclude=.claude/projects --exclude=.claude/logs --exclude=.claude/run \
       --exclude=.claude/todos --exclude=.claude/shell-snapshots \
       .claude .claude.json 2>/dev/null; then
    chmod 600 "$out"
    log "ok    config: $(basename "$out") ($(du -h "$out" | cut -f1))"
    # rotation: keeps the N newest
    ls -1t "$CFG_BACKUP_DIR"/config-*.tgz 2>/dev/null | tail -n +"$((CFG_KEEP + 1))" | xargs -r rm -f
  else
    log "WARN  config: could not create the tarball"
    return 1
  fi
}

backup_volume() {
  local dest="${VOLUME_BACKUP_DIR:-}" keep="${VOLUME_BACKUP_KEEP:-7}" stamp prev ex
  [ -n "$dest" ] || { log "skip  (volume): VOLUME_BACKUP_DIR is not set"; return 0; }
  dest="$(realpath -m "$dest")"
  # a copy inside the volume itself is not a backup (it goes away with it) and would copy itself
  case "$dest/" in "$(realpath -m "$H")/"*) log "WARN  (volume): VOLUME_BACKUP_DIR ($dest) is inside $H — use another disk/mount"; return 1 ;; esac
  mkdir -p "$dest" || { log "WARN  (volume): cannot create $dest"; return 1; }
  command -v rsync >/dev/null || { log "WARN  (volume): rsync not found"; return 1; }
  stamp="$(date '+%Y%m%d-%H%M%S')"
  prev="$(find "$dest" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]*' ! -name '*.partial' | sort | tail -n 1)"
  local args=(-aH --delete --numeric-ids --one-file-system
    --exclude=node_modules/ --exclude=.cache/ --exclude=.npm/ --exclude=.gradle/ --exclude=.bun/install/cache/
    --exclude=.claude/worktrees/ --exclude=/.claude-backups/ --exclude=/.claude/run/ --exclude=/.claude/logs/)
  IFS=',' read -r -a ex <<< "${VOLUME_BACKUP_EXCLUDE:-}"
  for e in "${ex[@]}"; do [ -n "${e// /}" ] && args+=("--exclude=${e// /}"); done
  [ -n "$prev" ] && args+=("--link-dest=$prev")
  # copy into <stamp>.partial and rename at the end: a copy cut in the middle never looks complete
  if rsync "${args[@]}" "$H/" "$dest/$stamp.partial/" 2>>"$LOG_DIR/backup-volume.err"; then
    mv "$dest/$stamp.partial" "$dest/$stamp"
    ln -sfn "$stamp" "$dest/latest"
    log "ok    (volume): $stamp ($(du -sh --apparent-size "$dest/$stamp" 2>/dev/null | cut -f1) of files${prev:+, unchanged files shared with $(basename "$prev")})"
    find "$dest" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]*' ! -name '*.partial' | sort | head -n -"$keep" | xargs -r rm -rf
    find "$dest" -mindepth 1 -maxdepth 1 -type d -name '*.partial' ! -name "$stamp.partial" -mmin +60 -exec rm -rf {} + 2>/dev/null
  else
    log "WARN  (volume): rsync failed (see $LOG_DIR/backup-volume.err); the incomplete copy stays as $stamp.partial"
    alert warn backup "" "Volume backup failed (rsync). See backup-volume.err." srv.alert.volumeBackupFailed
    return 1
  fi
}

backup_repo() {
  local dir="$1" name
  [ -d "$dir/.git" ] || return 0                       # not a git repo -> skip
  name=$(basename "$dir")

  # needs an 'origin' remote to have somewhere to push
  if ! git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    log "skip  $name: no 'origin' remote (set it up: git remote add origin <url>)"
    return 0
  fi

  # fallback local identity (in case the global one does not exist)
  git -C "$dir" config user.email >/dev/null 2>&1 || git -C "$dir" config user.email "devbox@localhost"
  git -C "$dir" config user.name  >/dev/null 2>&1 || git -C "$dir" config user.name  "claude-devbox"

  # A merge/rebase/cherry-pick/revert half done (someone or Claude is in the middle of it): an
  # automatic `add -A` + commit would record the conflict markers and break that operation.
  # Detached HEAD (bisect, checked-out tag/commit): the commit would land on no branch and the
  # push would fail or go somewhere unexpected. In both cases: skip, and say why.
  local gd op=""
  gd="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)" || return 0
  for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply BISECT_LOG; do
    [ -e "$gd/$f" ] && { op="$f"; break; }
  done
  if [ -n "$op" ]; then
    log "skip  $name: a git operation is in progress ($op) — finish or abort it; backup postponed"
    return 0
  fi
  if ! git -C "$dir" symbolic-ref -q HEAD >/dev/null 2>&1; then
    log "skip  $name: detached HEAD (no branch checked out) — backup postponed"
    return 0
  fi

  # nothing changed -> nothing to do
  if [ -z "$(git -C "$dir" status --porcelain)" ]; then
    return 0
  fi

  # SECURITY: `add -A` with no exception would push the worklog to GitHub without human
  # review. The worklog is written by the Stop hook from the TRANSCRIPT, which may
  # contain secrets typed or generated in the session.
  #
  # The hook now redacts secrets before writing, but defense in depth:
  # an AUTOMATIC snapshot (with nobody looking) does not take the worklog. Whoever wants to
  # version a specific worklog does it in a manual commit, which goes through review.
  #
  # Same for .chat-uploads/ (any depth): photos/files sent from the chat or dropped on the
  # terminal are saved there. They are private and can be big; they are not project code.
  local skip_uploads=':(glob,exclude)**/.chat-uploads/**'
  git -C "$dir" add -A -- . ':!docs/worklog' "$skip_uploads"
  # The exclusion above only filters what is staged NOW — it does not undo what was already
  # in the index. Without this reset, a worklog staged before (by another
  # tool, or by a `git add` in a session) went into the snapshot anyway;
  # that is what happened in the 2026-08-09 14:41 snapshot.
  git -C "$dir" reset -q -- docs/worklog 2>/dev/null || true
  git -C "$dir" reset -q -- ':(glob)**/.chat-uploads/**' 2>/dev/null || true
  # Nothing left to commit after the reset? Then do not create an empty commit.
  if [ -z "$(git -C "$dir" diff --cached --name-only)" ]; then
    return 0
  fi
  git -C "$dir" commit -m "chore(backup): auto-snapshot $(date '+%F %T')" >/dev/null 2>&1
  # timeout: a push on a stuck network (no error, no progress) would hang forever and
  # the automatic loop (start.sh) would never call backup.sh again (found by @qa).
  if timeout 120 git -C "$dir" push >/dev/null 2>&1; then
    log "ok    $name: snapshot pushed"
  else
    log "WARN  $name: local commit done, push failed (remote/credentials/branch?)"
    alert warn backup "$name" "Backup of \"$name\": local commit done, but the push failed (remote/credentials/network?)." srv.alert.pushFailed "name=$name"
  fi
}

if [ "${1:-}" = "--config" ]; then
  backup_config
elif [ "${1:-}" = "--volume" ]; then
  backup_volume
elif [ "$#" -ge 1 ]; then
  backup_repo "$1"
else
  [ -d "$PROJECTS_DIR" ] || { log "folder $PROJECTS_DIR does not exist, nothing to do"; exit 0; }
  shopt -s nullglob
  for d in "$PROJECTS_DIR"/*/; do
    [ -d "$d" ] && backup_repo "${d%/}"
  done
fi
