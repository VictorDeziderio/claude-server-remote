# Ubuntu server com Claude Code (CLI) + Playwright + toolchain de dev completo.
# Sandbox/dev-box persistente no EasyPanel.
# Monte um Volume do EasyPanel em /root para o trabalho + login do Claude
# (~/.claude) nao sumirem no redeploy.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Sao_Paulo \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # browsers do Playwright FORA de /root (senao o volume montado em /root os esconde)
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# 1) Toolchain de dev + dependencias que o Claude Code usa (git, ripgrep, build, python...)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg lsb-release apt-transport-https \
        git openssh-client \
        ripgrep fd-find jq tree \
        build-essential make g++ pkg-config \
        python3 python3-pip python3-venv pipx \
        bash-completion locales sudo tini procps htop \
        unzip zip tar gzip xz-utils rsync nano vim \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# 2) Node.js 22 (LTS) via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# 3) GitHub CLI (gh) — usado pelo Claude para operacoes no GitHub
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# 4) Claude Code CLI + Playwright (global)
RUN npm install -g @anthropic-ai/claude-code playwright \
    && npm cache clean --force

# 5) Browsers do Playwright + dependencias de SO (em /opt/ms-playwright)
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Diretorio de trabalho (monte um Volume do EasyPanel em /root para persistir)
WORKDIR /root

# Mantem o container vivo (acesse pelo Console do EasyPanel e rode `claude`)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
