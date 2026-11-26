# Security

## Reporting a vulnerability

Please open a [private security advisory](../../security/advisories/new) on GitHub instead of a
public issue. Include the version (`panel/package.json`), how to reproduce it and what it allows.

## Threat model in short

Claude Remote gives a browser **a shell on the server** (the terminal, and Claude running with
`bypassPermissions`). Everything below protects that power.

- **Panel login** (`/api/*`, the terminal WebSocket): password + optional 2FA, signed and revocable
  session cookie, same-origin checks on every write, rate limit on failed logins, CSP, audit log.
- **Chat links** (`/remote/<project>?key=…`, API `/chat-api/*`) and **remote hub links**
  (`/remote?key=…`, API `/hub-api/*`): a random 256-bit key in the URL, sent as a Bearer token. The
  server keeps only its sha256. **Every key is an owner key**: a chat key drives the Claude of its
  project, a hub key drives every project of the server. Give them only to people you would give a
  shell, and revoke them in the panel (Configure → Chat link, Settings → Remote hub) when a device is
  lost. These two APIs never use cookies, so they allow any origin (CORS `*`): the key is the only
  proof. Wrong keys are rate limited per IP; a valid key is never blocked.
- **Saved hub links of other servers** carry those servers' keys and are stored (0600) in the panel
  state of this server: whoever owns this server can open them.
- **Backup restore** never restores the panel login, the hub people, the chat keys or the push
  devices from an archive, so an old or foreign backup cannot bring a revoked or unknown key in.
  Archives with absolute paths or `..` are refused before anything is written.
- **Files viewer**: images, media and SVG are served inline under a sandboxed CSP; PDF can only be
  framed by the panel itself; any other file is a download.

Put the panel behind HTTPS (`PANEL_DOMAIN`, or your own proxy with `TRUSTED_PROXIES`) — keys and
cookies travel in every request.
