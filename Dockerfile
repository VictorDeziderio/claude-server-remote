# Dev-box "claude" — imagem SELF-CONTAINED: constroi todo o toolchain + runtime aqui mesmo.
# Nao depende de imagem base externa (GHCR) -> builda sem credencial nenhuma. Mais lento no
# deploy (rebuilda o toolchain), porem sempre funciona.
#
# Monte um Volume do EasyPanel em /root para o trabalho + login do Claude (~/.claude)
# nao sumirem no redeploy.
FROM ubuntu:24.04

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

# 4) Claude Code + Playwright + gerenciadores JS (global)
RUN npm install -g @anthropic-ai/claude-code playwright pnpm yarn bun \
    && npm cache clean --force

# 5) Browsers do Playwright + dependencias de SO.
#    - chromium: bundled do Playwright (em /opt/ms-playwright)
#    - chrome: Google Chrome estavel real (canal "chrome"), instalado no sistema
#      (/opt/google/chrome) via apt. Use no Playwright com channel: 'chrome'.
RUN playwright install --with-deps chromium chrome \
    && rm -rf /var/lib/apt/lists/*

# 6) Caddy — gateway/reverse-proxy de uma porta so (painel em /).
# Binario unico, lida com WebSocket nativamente.
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

# ============================================================================
# Runtime: ENV + scripts (o que muda no dia a dia)
# ============================================================================
# Variaveis de runtime (sobrescreva no Environment do EasyPanel)
ENV \
    # Multi-tmux: cada projeto tem sua sessao "claude-<nome>" e seu remote-control.
    # PROJECT_FOLDER = nome do projeto default (criado se o container subir sem nenhum).
    # REMOTE_CONTROL_NAME vazio -> o remote usa o NOME DO PROJETO (ex.: /remote-control pilot).
    #   Defina um valor so se quiser FORCAR um nome fixo para todos os projetos.
    PROJECT_FOLDER=projects \
    REMOTE_CONTROL_NAME= \
    CLAUDE_AUTOCMD_DELAY=15 \
    # GitHub: token (escopo repo) p/ auto-login do gh e push do backup. Defina no Environment.
    GH_TOKEN= \
    # Backup automatico dos projetos: liga/desliga + intervalo (segundos)
    BACKUP_ENABLED=true \
    BACKUP_INTERVAL=3600 \
    # Gateway/painel: porta publica + dir dos projetos
    PANEL_ENABLED=true \
    GATEWAY_PORT=8080 \
    PROJECTS_DIR=/root/projects \
    # AUTH: painel via PANEL_LOGIN+PANEL_PASSWORD (pagina de login propria do painel).
    # TROQUE no Environment do EasyPanel.
    PANEL_LOGIN=admin \
    PANEL_PASSWORD=senha-antiga-removida

# Politica GLOBAL do Claude Code (managed settings) — permissao para TUDO em todo o
# container, para qualquer usuario/projeto. Fica em /etc (nao e ocultado pelo volume /root)
# e tem a maior precedencia (sobrepoe settings de usuario/projeto).
RUN mkdir -p /etc/claude-code
COPY managed-settings.json /etc/claude-code/managed-settings.json

# entrypoint + supervisor + sessao + backup + painel (o que muda no dia a dia)
COPY start.sh /usr/local/bin/start.sh
COPY claude-loop.sh /usr/local/bin/claude-loop.sh
COPY claude-session.sh /usr/local/bin/claude-session.sh
COPY backup.sh /usr/local/bin/backup.sh
COPY panel /usr/local/bin/panel
# Build do painel "Claude Remote" (Vite/React) -> dist/. node_modules e removido depois:
# em runtime o server.js usa SO modulos nativos do Node (http/fs/path/child_process).
RUN cd /usr/local/bin/panel \
    && npm ci \
    && npm run build \
    && rm -rf node_modules
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
# Acesse a sessao do Claude pelo Console do EasyPanel: `tmux attach -t claude-<projeto>`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
