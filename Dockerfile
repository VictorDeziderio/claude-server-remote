# Ubuntu server com Claude Code (CLI) + Playwright instalados.
# Usado como sandbox/dev-box persistente no EasyPanel.
# Monte um Volume do EasyPanel em /root para o trabalho + login do Claude
# (~/.claude) nao sumirem no redeploy.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=America/Sao_Paulo \
    LANG=C.UTF-8 \
    # browsers do Playwright FORA de /root (senao o volume montado em /root os esconde)
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Ferramentas base + Node.js 22 (LTS) via NodeSource
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git ripgrep less vim nano sudo \
        openssh-client tini procps unzip \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs

# Claude Code CLI + Playwright (global)
RUN npm install -g @anthropic-ai/claude-code playwright \
    && npm cache clean --force

# Browsers do Playwright + dependencias de SO (instalados em /opt/ms-playwright)
RUN playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Diretorio de trabalho (monte um Volume do EasyPanel em /root para persistir)
WORKDIR /root

# Mantem o container vivo (acesse pelo Console do EasyPanel e rode `claude`)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
