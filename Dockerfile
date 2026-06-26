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
    PASSWORD=senha-antiga-removida

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

# 5) Browsers do Playwright + dependencias de SO (em /opt/ms-playwright)
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# 6) code-server (VS Code no navegador)
RUN curl -fsSL https://code-server.dev/install.sh | sh

# 7) tmux (sessao persistente do Claude) — camada tardia p/ nao invalidar o cache pesado acima
RUN apt-get update && apt-get install -y --no-install-recommends tmux \
    && rm -rf /var/lib/apt/lists/*

# entrypoint: sobe sessao tmux "claude" (Claude Code) + code-server (IDE)
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

WORKDIR /root
EXPOSE 8080

# IDE em primeiro plano + sessao tmux "claude" persistente.
# Config/extensoes do code-server ficam em /root (volume) -> persistem no redeploy.
# Acesse a sessao do Claude: `tmux attach -t claude` (no terminal do IDE ou Console).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
