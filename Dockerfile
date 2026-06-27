# Ubuntu server: Claude Code + Playwright + code-server (IDE web) + toolchain completo.
# Dev-box persistente no EasyPanel. Monte um Volume do EasyPanel em /root para o
# trabalho + login do Claude (~/.claude) + extensoes do IDE nao sumirem no redeploy.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Sao_Paulo \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # browsers do Playwright FORA de /root (senao o volume montado em /root os esconde)
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    # IDE (code-server): habilita/desabilita + senha. Sobrescreva no Environment do EasyPanel.
    IDE_ENABLED=true \
    IDE_PASSWORD=senha-antiga-removida \
    # auto-start do Claude: pasta de trabalho + nome do remote-control + comando + delay
    PROJECT_FOLDER=projects \
    REMOTE_CONTROL_NAME=meu-servidor \
    CLAUDE_AUTOCMD="/remote-control" \
    CLAUDE_AUTOCMD_DELAY=15 \
    # GitHub: token (escopo repo) p/ auto-login do gh e push do backup. Defina no Environment.
    GH_TOKEN= \
    # Backup automatico dos projetos: liga/desliga + intervalo (segundos)
    BACKUP_ENABLED=true \
    BACKUP_INTERVAL=3600 \
    # Painel de controle: liga/desliga + porta + dir dos projetos + URL publica do IDE
    PANEL_ENABLED=true \
    PANEL_PORT=7000 \
    PROJECTS_DIR=/root/projects \
    IDE_PUBLIC_URL=

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

# 6) code-server (VS Code no navegador)
RUN curl -fsSL https://code-server.dev/install.sh | sh

# 7) tmux + gosu + usuario nao-root — camada tardia p/ nao invalidar o cache pesado acima.
# O Claude Code se recusa a rodar como root com --dangerously-skip-permissions, entao
# rodamos como o usuario "ubuntu" (uid 1000), usando /root (o volume) como home dele.
RUN apt-get update && apt-get install -y --no-install-recommends tmux gosu \
    && rm -rf /var/lib/apt/lists/* \
    && (id ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash -u 1000 ubuntu) \
    && usermod -d /root ubuntu \
    && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu \
    && chmod 0440 /etc/sudoers.d/ubuntu

# Politica GLOBAL do Claude Code (managed settings) — permissao para TUDO em todo o
# container, para qualquer usuario/projeto. Fica em /etc (nao e ocultado pelo volume /root)
# e tem a maior precedencia (sobrepoe settings de usuario/projeto).
RUN mkdir -p /etc/claude-code
COPY managed-settings.json /etc/claude-code/managed-settings.json

# entrypoint + supervisor + sessao + backup + painel
COPY start.sh /usr/local/bin/start.sh
COPY claude-loop.sh /usr/local/bin/claude-loop.sh
COPY claude-session.sh /usr/local/bin/claude-session.sh
COPY backup.sh /usr/local/bin/backup.sh
COPY panel /usr/local/bin/panel
RUN chmod +x /usr/local/bin/start.sh /usr/local/bin/claude-loop.sh \
        /usr/local/bin/claude-session.sh /usr/local/bin/backup.sh

WORKDIR /root
EXPOSE 8080 7000

# Healthcheck (item 4): code-server expoe /healthz. Marca o container unhealthy se
# o IDE travar, permitindo restart automatico. Assume IDE_ENABLED=true (default).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1

# IDE em primeiro plano + sessao tmux "claude" persistente.
# Config/extensoes do code-server ficam em /root (volume) -> persistem no redeploy.
# Acesse a sessao do Claude: `tmux attach -t claude` (no terminal do IDE ou Console).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
