#!/usr/bin/env bash
# Makes sure a project's tmux session (claude-<name>) exists as panel.json says — multi-tmux model.
#
#   enabled=false          -> project OFF: does NOT create a session (boot/watchdog respect it)
#   autoStartClaude=true   -> the session runs the claude-loop.sh supervisor (Claude in a loop)
#                  =false  -> the session is just a shell in the project folder
#   autoRemote / initLine  -> read by claude-loop.sh on EACH Claude start (changed in the
#                             panel -> applies on the next (re)start, without recreating the session)
#
# Idempotent: does not touch a session that already exists. Runs as the ubuntu user (HOME=/root).
#
# Usage:  claude-session.sh <project>
#       claude-session.sh --all        # every project that is ON (boot + watchdog); if there
#                                      # is no project at all, creates the default ($PROJECT_FOLDER)
set -uo pipefail

LIB="${DEVBOX_LIB:-/usr/local/lib/devbox/lib.sh}"
# shellcheck source=devbox-lib.sh
. "$LIB"
LOOP="${CLAUDE_LOOP:-/usr/local/bin/claude-loop.sh}"

ensure_one() {  # $1 = project
  local name="$1" sess proj
  valid_name "$name" || { echo "[session] invalid name: $name" >&2; return 1; }
  sess="$(sess_name "$name")"
  proj="$PROJECTS_DIR/$name"

  tmux has-session -t "=$sess" 2>/dev/null && return 0   # already exists -> nothing to do
  # the panel has just killed this session and is about to recreate it (recreateSession) --
  # do not interfere at that moment (avoids a race with the watchdog, found by @qa 2026-09-28).
  # The lock only exists during the kill; the panel's own ensureSession runs AFTER it
  # is released, so there is no deadlock here.
  [ -f "$RUN_DIR/$sess.lock" ] && return 0

  load_proj_config "$name"
  [ "$CFG_ENABLED" = "true" ] || return 0              # off -> stays off
  # NEVER recreates the folder: a deleted project must stay deleted. There used to be a mkdir -p
  # here, and a terminal tab still open (or the watchdog in the middle of a deletion) brought
  # the deleted project back (bug of the "codigo" project, 2026-11-24). Who creates folders: the panel
  # (createProject) and ensure_all (default project).
  [ -d "$proj" ] || { echo "[session] project '$name' does not exist (missing folder) — nothing to start" >&2; return 1; }

  if [ "$CFG_AUTOSTART" = "true" ]; then
    # supervisor as the session's DIRECT COMMAND (no send-keys -> no race with the shell loading)
    tmux new-session -d -s "$sess" -c "$proj" \
      "exec bash $(printf '%q' "$LOOP") $(printf '%q' "$sess") $(printf '%q' "$name")"
  else
    tmux new-session -d -s "$sess" -c "$proj" \
      "printf '\\033[90m[dev-box] project \"%s\": Claude OFF (panel). Run  claude  whenever you want.\\033[0m\\n' $(printf '%q' "$name"); exec bash -l"
  fi
}

# same rule as panel/server/projects-list.js: hidden folders, linked git worktrees (.git is a file)
# and "<project>.<x>" next to an existing <project> are not projects (Claude makes worktrees there)
is_project_dir() {
  local n="$1"
  case "$n" in .*) return 1 ;; esac
  [ -f "$PROJECTS_DIR/$n/.git" ] && return 1
  case "$n" in *.*) [ -d "$PROJECTS_DIR/${n%%.*}" ] && return 1 ;; esac
  return 0
}

ensure_all() {
  shopt -s nullglob
  local any=0 d n
  mkdir -p "$PROJECTS_DIR"
  for d in "$PROJECTS_DIR"/*/; do
    n="$(basename "${d%/}")"
    is_project_dir "$n" || continue
    any=1
    # the failure of ONE session never aborts the others (nor the boot)
    ensure_one "$n" || echo "[session] warning: project '$n' failed to start" >&2
  done
  if [ "$any" = "0" ]; then                            # container without projects -> creates the default
    n="${PROJECT_FOLDER:-projects}"
    mkdir -p "$PROJECTS_DIR/$n"
    ensure_one "$n" || echo "[session] warning: default project '$n' failed to start" >&2
  fi
}

case "${1:-}" in
  "") echo "usage: claude-session.sh <project> | --all" >&2; exit 2 ;;
  --all) ensure_all ;;
  *) ensure_one "$1" ;;
esac
