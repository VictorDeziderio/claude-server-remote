# Dev box "claude" — SELF-CONTAINED image: builds the whole toolchain + runtime right here.
# Does not depend on an external base image (GHCR) -> builds with no credentials at all.
#
# Multi-stage: the panel (React/Vite/xterm.js + node-pty) is built in a separate Node stage and
# only the result (dist/ + runtime deps) goes into the final image. PINNED versions (ARG) for
# reproducible builds — bump them on purpose, not by accident.
#
# Mount a volume at /root so the work + the Claude login (~/.claude)
# do not disappear on a redeploy.

# Claude Code: "latest" (default) installs the NEWEST npm version on each build — the ADD of the
# registry manifest (step 8) invalidates the Docker cache when a new version comes out. To pin,
# pass an exact version (e.g. --build-arg CLAUDE_CODE_VERSION=2.1.284).
ARG CLAUDE_CODE_VERSION=latest
ARG PLAYWRIGHT_VERSION=1.62.1
# which browsers Playwright installs: "auto" (default: "chromium chrome" on amd64, only "chromium"
# on arm64 — Google Chrome has no Linux arm64 package) | "chromium chrome" | "chrome" | "chromium"
# | "none" (smaller image, no browsers)
ARG PLAYWRIGHT_BROWSERS=auto
ARG CADDY_VERSION=2.11.7

# ============================================================================
# Stage 1: panel build (dist/ + runtime-only node_modules: ws + compiled node-pty)
# ============================================================================
FROM node:22-bookworm-slim AS panel-build
# flaky network (ECONNRESET in the middle of a download broke a rebuild on 2026-10-10): npm
# retries each package with a growing wait instead of giving up at the first drop
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
# and if the network goes down for good, 2 more full passes before failing the build
RUN for i in 1 2 3; do npm ci --no-audit --no-fund && break; [ "$i" = 3 ] && exit 1; sleep 15; done
COPY panel/ ./
# build stamp (shown in the panel footer -> tells whether the new deploy is live)
RUN date -u +%Y-%m-%dT%H:%M:%SZ > BUILD_TIME
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && mkdir -p /tmp/keep/lib && cp src/lib/i18n-core.js /tmp/keep/lib/ && cp -r src/locales /tmp/keep/ \
    && rm -rf src public test index.html vite.config.mjs \
    && mv /tmp/keep src
# The server also reads src/lib/i18n-core.js and src/locales/*.json at runtime (texts and
# language rules shared with the browser), so those two stay; the rest of src/ is in dist/.

# ============================================================================
# Stage 2: imagem final (Ubuntu 24.04 + toolchain + Claude Code + Playwright + tmux + Caddy)
# ============================================================================
FROM ubuntu:24.04
ARG CLAUDE_CODE_VERSION
ARG PLAYWRIGHT_VERSION
ARG PLAYWRIGHT_BROWSERS
ARG CADDY_VERSION

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # Playwright browsers OUTSIDE /root (otherwise the volume mounted at /root hides them)
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# 1) Dev toolchain + Claude dependencies (git, ripgrep, build, python, psql...)
#    (Acquire::Retries: apt retries a download that drops midway, in every following step)
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg lsb-release apt-transport-https \
        git openssh-client \
        ripgrep fd-find jq tree \
        build-essential make g++ pkg-config \
        python3 python3-pip python3-venv pipx \
        postgresql-client \
        bash-completion locales sudo tini procps htop \
        unzip zip tar gzip xz-utils rsync nano vim \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# 2) Node.js 22 (LTS) via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 3) GitHub CLI (gh)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# 4) Playwright (pinned version) + JS package managers (global). Claude Code comes in step 8.
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" pnpm yarn bun \
    && npm cache clean --force

# 5) Playwright browsers + OS dependencies (see ARG PLAYWRIGHT_BROWSERS).
#    - chromium: bundled with Playwright (in /opt/ms-playwright)
#    - chrome: the real stable Google Chrome ("chrome" channel). Use it in Playwright with channel: 'chrome'.
RUN set -e; B="${PLAYWRIGHT_BROWSERS}"; \
    if [ "$B" = "auto" ]; then \
      if [ "$(dpkg --print-architecture)" = "amd64" ]; then B="chromium chrome"; else B="chromium"; fi; \
    fi; \
    if [ "$B" != "none" ]; then playwright install --with-deps $B; fi; \
    rm -rf /var/lib/apt/lists/*

# 6) Caddy — single-port gateway/reverse proxy (panel at /). Handles WebSocket natively.
# Official binary from GitHub Releases (no longer from Cloudsmith's apt: their public repo
# started to require payment — HTTP 402 Payment Required, breaking the build from 2026-10-09).
RUN set -e; \
    ARCH="$(dpkg --print-architecture)"; \
    curl -fsSL --retry 5 --retry-delay 10 --retry-all-errors -o /tmp/caddy.tar.gz \
        "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz" \
    && tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy \
    && chmod +x /usr/local/bin/caddy \
    && rm -f /tmp/caddy.tar.gz \
    && caddy version

# 7) tmux + gosu + non-root user.
# Claude Code refuses to run as root with --dangerously-skip-permissions, so the
# PROCESSES (claude, panel, git, gh, tmux sessions) run as the "ubuntu" user (uid 1000),
# with /root (the volume) as its home. The CONTAINER itself starts as root (PID 1 = tini ->
# start.sh): only root can fix the volume ownership on each boot before dropping to the user via
# gosu (see start.sh). There is no `USER ubuntu` in this Dockerfile on purpose.
RUN apt-get update && apt-get install -y --no-install-recommends tmux gosu \
    && rm -rf /var/lib/apt/lists/* \
    && (id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash -u 1000 ubuntu) \
    && usermod -d /root ubuntu \
    && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu
# Global tmux config (truecolor, mouse, window-size latest for several clients, status bar
# in the panel's theme). In /etc so the volume mounted at /root does not hide it.
COPY tmux.conf /etc/tmux.conf

# 8) Claude Code — last among the tools: when a new version comes out, only this layer (and the
#    next ones) is rebuilt; Playwright/Chrome/apt stay in the cache.
#    The ADD of a remote URL is compared on each build: "latest" changed on npm -> cache invalidated.
ADD https://registry.npmjs.org/@anthropic-ai/claude-code/latest /tmp/claude-code-latest.json
#    Since 2.1.28x `claude` is a NATIVE BINARY in a per-platform optional dependency; if its
#    download fails npm only warns and the image would ship with a broken Claude. Hence: up to 3
#    attempts, and the build FAILS if `claude --version` does not run at the end.
RUN set -e; V="${CLAUDE_CODE_VERSION}"; \
    if [ "$V" = "latest" ]; then V="$(jq -r .version /tmp/claude-code-latest.json)"; fi; \
    for i in 1 2 3; do \
      npm install -g --include=optional "@anthropic-ai/claude-code@${V}" \
        && claude --version >/dev/null 2>&1 && break; \
      echo ">> tentativa $i: binario nativo do Claude Code ausente — reinstalando"; sleep 5; \
    done; \
    claude --version || { echo ">> ERRO: Claude Code ${V} sem binario nativo"; exit 1; }; \
    npm cache clean --force; rm -f /tmp/claude-code-latest.json

# ============================================================================
# Runtime: ENV + scripts (what changes day to day)
# ============================================================================
# Runtime variables (override with docker run -e / compose)
ENV \
    # Multi-tmux: each project has its own "claude-<name>" session and its own remote-control.
    # PROJECT_FOLDER = name of the default project (created if the container starts with none).
    # REMOTE_CONTROL_NAME empty -> remote-control uses the PROJECT NAME (e.g. /remote-control pilot).
    PROJECT_FOLDER=claude \
    REMOTE_CONTROL_NAME= \
    CLAUDE_AUTOCMD_DELAY=15 \
    # Automatic project backup: on/off + interval (seconds); config 1x/day
    BACKUP_ENABLED=true \
    BACKUP_INTERVAL=3600 \
    CONFIG_BACKUP_INTERVAL=86400 \
    # Gateway/panel: public port + projects folder
    PANEL_ENABLED=true \
    GATEWAY_PORT=8080 \
    PROJECTS_DIR=/root/projects \
    # Claude Code updates: the panel installs new versions itself (panel/server/claude-update.js),
    # because Claude's own updater cannot write to the root-owned global install.
    DISABLE_AUTOUPDATER=1 \
    # AUTH: panel via PANEL_LOGIN+PANEL_PASSWORD (+ optional 2FA turned on in the panel).
    # PANEL_PASSWORD and GH_TOKEN have NO ENV here on purpose: without a password the panel REFUSES to start
    # (fail-closed in panel/server/auth.js). Right place: /root/.devbox-secrets.env on the volume
    # (KEY=value; see start.sh) -- on platforms that pass the Environment as --build-arg they leak into the build log.
    PANEL_LOGIN=admin \
    PANEL_SESSION_DAYS=30

# GLOBAL Claude Code policy (managed settings) — permission for EVERYTHING in the whole
# container, for any user/project. Lives in /etc (not hidden by the /root volume)
# and has the highest precedence (overrides user/project settings).
RUN mkdir -p /etc/claude-code
COPY managed-settings.json /etc/claude-code/managed-settings.json

# entrypoint + supervisor + session + backup (+ the scripts' shared library)
COPY devbox-lib.sh /usr/local/lib/devbox/lib.sh
COPY start.sh /usr/local/bin/start.sh
COPY claude-loop.sh /usr/local/bin/claude-loop.sh
COPY claude-session.sh /usr/local/bin/claude-session.sh
COPY backup.sh /usr/local/bin/backup.sh
# Claude Code hook (registered in managed-settings.json) -> push notifications of the panel
COPY devbox-hook.sh /usr/local/bin/devbox-hook.sh
# "Claude Remote" panel already built (stage 1): server.js + server/ + dist/ + node_modules (runtime)
COPY --from=panel-build --chown=ubuntu:ubuntu /panel /usr/local/bin/panel
# Seed of panel.json (project config) — copied to the volume on the first start (start.sh)
COPY panel.json /usr/local/share/claude/panel.json
RUN chmod +x /usr/local/bin/start.sh /usr/local/bin/claude-loop.sh \
        /usr/local/bin/claude-session.sh /usr/local/bin/backup.sh /usr/local/bin/devbox-hook.sh

WORKDIR /root
EXPOSE 8080

# Healthcheck: hits the GATEWAY (Caddy answers /healthz with "ok", no auth and always
# up). Generous start-period for Caddy/panel to come up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS "http://localhost:${GATEWAY_PORT:-8080}/healthz" || exit 1

# Gateway (Caddy) in the foreground + persistent tmux sessions per project.
# Open the Claude session in the panel terminal (/terminal/<project>) or from the console
# (docker exec): `tmux attach -t claude-<project>`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
