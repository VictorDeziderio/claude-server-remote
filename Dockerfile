# Dev-box "claude" — imagem SELF-CONTAINED: constroi todo o toolchain + runtime aqui mesmo.
# Nao depende de imagem base externa (GHCR) -> builda sem credencial nenhuma.
#
# Multi-stage: o painel (React/Vite/xterm.js + node-pty) e buildado numa stage Node separada e
# so o resultado (dist/ + deps de runtime) entra na imagem final. Versoes PINADAS (ARG) para
# builds reproduziveis — suba-as de proposito, nao por acidente.
#
# Monte um Volume do EasyPanel em /root para o trabalho + login do Claude (~/.claude)
# nao sumirem no redeploy.

# Claude Code: "latest" (default) instala a versao MAIS RECENTE do npm em cada build — o ADD do
# manifesto do registry (etapa 8) invalida o cache do Docker quando sai versao nova. Para pinar,
# passe uma versao exata (ex.: --build-arg CLAUDE_CODE_VERSION=2.1.284).
ARG CLAUDE_CODE_VERSION=latest
ARG PLAYWRIGHT_VERSION=1.62.1
# quais browsers instalar no Playwright: "chromium chrome" (default) | "chrome" (so o Google Chrome,
# ~300MB a menos; scripts sem channel:'chrome' deixam de funcionar) | "chromium"
ARG PLAYWRIGHT_BROWSERS="chromium chrome"

# ============================================================================
# Stage 1: build do painel (dist/ + node_modules so de runtime: ws + node-pty compilado)
# ============================================================================
FROM node:22-bookworm-slim AS panel-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY panel/ ./
# carimbo do build (aparece no rodape do painel -> da pra saber se o deploy novo esta no ar)
RUN date -u +%Y-%m-%dT%H:%M:%SZ > BUILD_TIME
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && rm -rf src public test index.html vite.config.mjs tailwind.config.js postcss.config.js

# ============================================================================
# Stage 2: imagem final (Ubuntu 24.04 + toolchain + Claude Code + Playwright + tmux + Caddy)
# ============================================================================
FROM ubuntu:24.04
ARG CLAUDE_CODE_VERSION
ARG PLAYWRIGHT_VERSION
ARG PLAYWRIGHT_BROWSERS

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Sao_Paulo \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # browsers do Playwright FORA de /root (senao o volume montado em /root os esconde)
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# 1) Toolchain de dev + dependencias do Claude (git, ripgrep, build, python, psql...)
RUN apt-get update && apt-get install -y --no-install-recommends \
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

# 4) Playwright (versao pinada) + gerenciadores JS (global). O Claude Code vem na etapa 8.
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" pnpm yarn bun \
    && npm cache clean --force

# 5) Browsers do Playwright + dependencias de SO (ver ARG PLAYWRIGHT_BROWSERS).
#    - chromium: bundled do Playwright (em /opt/ms-playwright)
#    - chrome: Google Chrome estavel real (canal "chrome"). Use no Playwright com channel: 'chrome'.
RUN playwright install --with-deps ${PLAYWRIGHT_BROWSERS} \
    && rm -rf /var/lib/apt/lists/*

# 6) Caddy — gateway/reverse-proxy de uma porta so (painel em /). Lida com WebSocket nativamente.
RUN curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
        > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/*

# 7) tmux + gosu + usuario nao-root.
# O Claude Code se recusa a rodar como root com --dangerously-skip-permissions, entao
# rodamos como o usuario "ubuntu" (uid 1000), usando /root (o volume) como home dele.
RUN apt-get update && apt-get install -y --no-install-recommends tmux gosu \
    && rm -rf /var/lib/apt/lists/* \
    && (id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash -u 1000 ubuntu) \
    && usermod -d /root ubuntu \
    && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu
# Config global do tmux (truecolor, mouse, window-size latest p/ varios clientes, status
# com o tema do painel). Em /etc para nao ser ocultada pelo volume montado em /root.
COPY tmux.conf /etc/tmux.conf

# 8) Claude Code — por ultimo entre as ferramentas: quando sai versao nova, so esta camada (e as
#    seguintes) e refeita; Playwright/Chrome/apt ficam no cache.
#    O ADD de uma URL remota e comparado a cada build: mudou o "latest" no npm -> cache invalidado.
ADD https://registry.npmjs.org/@anthropic-ai/claude-code/latest /tmp/claude-code-latest.json
#    Desde a 2.1.28x o `claude` e um BINARIO NATIVO numa dependencia opcional por plataforma; se o
#    download dele falha o npm so avisa e a imagem sairia com o Claude quebrado. Por isso: ate 3
#    tentativas e o build REPROVA se `claude --version` nao rodar no fim.
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
# Runtime: ENV + scripts (o que muda no dia a dia)
# ============================================================================
# Variaveis de runtime (sobrescreva no Environment do EasyPanel)
ENV \
    # Multi-tmux: cada projeto tem sua sessao "claude-<nome>" e seu remote-control.
    # PROJECT_FOLDER = nome do projeto default (criado se o container subir sem nenhum).
    # REMOTE_CONTROL_NAME vazio -> o remote usa o NOME DO PROJETO (ex.: /remote-control pilot).
    PROJECT_FOLDER=projects \
    REMOTE_CONTROL_NAME= \
    CLAUDE_AUTOCMD_DELAY=15 \
    # GitHub: token (escopo repo) p/ auto-login do gh e push do backup. Defina no Environment.
    GH_TOKEN= \
    # Backup automatico dos projetos: liga/desliga + intervalo (segundos); config 1x/dia
    BACKUP_ENABLED=true \
    BACKUP_INTERVAL=3600 \
    CONFIG_BACKUP_INTERVAL=86400 \
    # Gateway/painel: porta publica + dir dos projetos
    PANEL_ENABLED=true \
    GATEWAY_PORT=8080 \
    PROJECTS_DIR=/root/projects \
    # AUTH: painel via PANEL_LOGIN+PANEL_PASSWORD (+ 2FA opcional ativado no painel).
    # PANEL_PASSWORD fica VAZIO de proposito: o painel expoe um shell e, sem senha (ou com o
    # default publico antigo), RECUSA subir (fail-closed em panel/server/auth.js). Defina no
    # Environment do EasyPanel. Nao coloque default aqui: tudo que esta no repo e publico.
    PANEL_LOGIN=admin \
    PANEL_PASSWORD= \
    PANEL_SESSION_DAYS=30

# Politica GLOBAL do Claude Code (managed settings) — permissao para TUDO em todo o
# container, para qualquer usuario/projeto. Fica em /etc (nao e ocultado pelo volume /root)
# e tem a maior precedencia (sobrepoe settings de usuario/projeto).
RUN mkdir -p /etc/claude-code
COPY managed-settings.json /etc/claude-code/managed-settings.json

# entrypoint + supervisor + sessao + backup (+ biblioteca comum dos scripts)
COPY devbox-lib.sh /usr/local/lib/devbox/lib.sh
COPY start.sh /usr/local/bin/start.sh
COPY claude-loop.sh /usr/local/bin/claude-loop.sh
COPY claude-session.sh /usr/local/bin/claude-session.sh
COPY backup.sh /usr/local/bin/backup.sh
# painel "Claude Remote" ja buildado (stage 1): server.js + server/ + dist/ + node_modules (runtime)
COPY --from=panel-build --chown=ubuntu:ubuntu /panel /usr/local/bin/panel
# Semente do panel.json (config dos projetos) — copiada p/ o volume na 1a subida (start.sh)
COPY panel.json /usr/local/share/claude/panel.json
RUN chmod +x /usr/local/bin/start.sh /usr/local/bin/claude-loop.sh \
        /usr/local/bin/claude-session.sh /usr/local/bin/backup.sh

WORKDIR /root
EXPOSE 8080

# Healthcheck: bate no GATEWAY (Caddy responde /healthz com "ok", sem auth e sempre
# de pe). start-period generoso pro Caddy/painel subirem.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://localhost:${GATEWAY_PORT:-8080}/healthz" || exit 1

# Gateway (Caddy) em primeiro plano + sessoes tmux por projeto persistentes.
# Acesse a sessao do Claude pelo terminal do painel (/terminal/<projeto>) ou pelo Console
# do EasyPanel: `tmux attach -t claude-<projeto>`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
