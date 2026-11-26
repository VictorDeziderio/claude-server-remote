# Changelog

## Unreleased

**Security**
- Wrong chat/hub keys are rate limited per IP, but a valid key is never blocked (behind a proxy that
  hides client IPs, a flood of bad keys locked everyone out). `SECURITY.md` describes the threat model.

**New**
- Remote hub: one link per person (`/remote?key=…`, made in Settings → Remote hub) that opens the
  chat of every project of the server, the Claude accounts (plans, limits, which account each
  project uses, switch by hand), usage and a report by dates, and the server (CPU, memory, disk,
  Claude version). Each person keeps a list of links of project chats or hubs of other servers,
  saved on the server; other servers are read live (`/hub-api` and `/chat-api` allow any origin:
  Bearer keys only). Works on a computer (sidebar) and as an iPhone home-screen app (tab bar).
- Backup → Import / restore: send a `.tgz` (a config tarball or one project folder) or pick a
  config backup of the server or a project of a copy of the volume, then restore. The config is
  merged after a safety backup (the panel login is kept, the panel restarts by itself); a project
  is restored as a new one or over one that is off (the old folder is moved aside, never deleted).
- Files: images, PDF, video and audio open in a viewer (no download), with previous / next among
  the files of the folder (buttons, ← →, swipe), download and "open in a new tab". A link straight
  to an image opens its folder with the viewer on it. Inline files are served sandboxed (SVG) or
  framed by the panel only (PDF), with byte ranges for video.

## 4.0.0 — 2026-11-26

**Breaking**
- Project chat (`/remote/<project>?key=…`) is now ONE live conversation per project, the same one
  the project's terminal Claude uses: messages are typed into it, Claude's questions become buttons,
  Stop sends Escape. The conversation list, "new conversation" and the headless `claude -p` engine
  are gone. Limited (guest) chat keys were removed: only owner keys work.
- The accounts page moved from `/account` to `/accounts` (the old address redirects).

**New**
- Several Claude accounts: add them in `/accounts` (own login or a pasted long-lived token, own
  usage), pick one per project in Configure → Account. Conversation history stays shared, so a
  switch keeps the conversation. Switching is always manual.
- Push notifications from the chat app (works as an iPhone home-screen app): Claude asked a
  question (with its text) and Claude finished. Desktop layout with a side panel.
- Terminal: drop, paste or pick an image to send it to Claude (its path is typed for you).
- Huge conversation files are read by windows; titles skip "continue" and use `/rename` names.
- Settings: update the panel from the panel (deploy webhook), now or when idle; Claude Code
  auto-update with version check and rollback.

**Fixes**
- A `claude -p` run no longer leaves a turn open (a restart typed "continue" into an idle Claude).
- New accounts log in (the panel typed `/login` too early and misread the menu cursor).
- Git worktrees Claude creates next to a project are not new projects.
- A failing file stream no longer crashes the panel; revoking sessions closes open terminals and
  streams; slow uploads are not cut; the limited-role guard fails closed.
- Phone: file actions visible on touch, unsaved edits are not dropped, toasts above the keyboard,
  status bar readable on the light theme, proper home-screen icons.
- Ops: healthcheck goes through the panel (also with a domain), git backups skip uploads and
  merges, one lock per backup kind, secrets file values are unquoted, audit log trimmed.
