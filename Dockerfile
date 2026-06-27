# Dev-box "claude" — camada LEVE sobre a imagem base (toolchain pesado).
# Parte da base publicada no GHCR e so adiciona ENV de runtime + scripts -> deploy rapido.
# A base (Node, Playwright+browsers, code-server, Caddy, toolchain) so muda quando voce
# edita claude/Dockerfile.base (o GitHub Action rebuilda e republica).
#
# Monte um Volume do EasyPanel em /root para o trabalho + login do Claude (~/.claude) +
# extensoes do IDE nao sumirem no redeploy.
FROM ghcr.io/meu-servidor/claude-devbox-base:latest

# Variaveis de runtime (sobrescreva no Environment do EasyPanel)
ENV IDE_ENABLED=true \
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
    # Gateway/painel: porta publica + dir dos projetos
    PANEL_ENABLED=true \
    GATEWAY_PORT=8080 \
    PROJECTS_DIR=/root/projects \
    IDE_PUBLIC_URL= \
    # AUTH: painel via LOGIN+PASSWORD (basic_auth do gateway); /ide via TOKEN (code-server).
    # Defina PANEL_PASSWORD e IDE_TOKEN no Environment do EasyPanel. Vazio -> cai no IDE_PASSWORD.
    PANEL_LOGIN=admin \
    PANEL_PASSWORD= \
    IDE_TOKEN=

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
# Semente do panel.json (config dos projetos) — copiada p/ o volume na 1a subida (start.sh)
COPY panel.json /usr/local/share/claude/panel.json
RUN chmod +x /usr/local/bin/start.sh /usr/local/bin/claude-loop.sh \
        /usr/local/bin/claude-session.sh /usr/local/bin/backup.sh

WORKDIR /root
EXPOSE 8080 7000

# Healthcheck: bate no code-server interno (8081/healthz, sem auth) — independe da
# GATEWAY_PORT. start-period generoso pro code-server/Caddy subirem.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:8081/healthz || exit 1

# Gateway (Caddy) em primeiro plano + sessao tmux "claude" persistente.
# Config/extensoes do code-server ficam em /root (volume) -> persistem no redeploy.
# Acesse a sessao do Claude: `tmux attach -t claude` (no terminal do IDE ou Console).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]
