# Claude Remote — Dev-box (painel + Claude Code + Playwright) no EasyPanel

Ubuntu 24.04 com um **painel "Claude Remote"** (React + xterm.js) para gerenciar projetos +
**Claude Code CLI** rodando em **tmux** + **Playwright** + toolchain de dev completo.
Persistente: seus projetos e o login do Claude **não somem** no redeploy.

Acesso por **uma porta só** (gateway Caddy = `GATEWAY_PORT`, default **8080**):
- **Painel:** `https://<domínio>/` — **página de login** (`PANEL_LOGIN` + `PANEL_PASSWORD`, 2FA opcional)
- **Projeto/serviço EasyPanel:** `meu-projeto` / `claude` · ex.: `https://claude.exemplo.easypanel.host`

> 🔌 **Porta de acesso:** aponte o domínio do serviço no EasyPanel para a **`GATEWAY_PORT` (8080)**.
> Internamente o painel roda em `127.0.0.1:7001` (não exposto).

---

## 🚀 Como usar (passo a passo)

### 1. Entrar no painel
Abra `https://<domínio>/` → **tela de login**. Entre com **`PANEL_LOGIN`** (default `admin`) e a
senha **`PANEL_PASSWORD`**. Recomendado: em **Conta → Ativar 2FA** (código do celular além da senha).
No celular, "Adicionar à tela inicial" instala o painel como app (PWA) e habilita notificações.

### 2. Terminal — igual a um SSH, no navegador
Menu **Terminal** (ou `https://<domínio>/terminal/<projeto>`). É um terminal **de verdade**:
**xterm.js (WebGL) ↔ WebSocket ↔ PTY (`node-pty`) ↔ `tmux attach`**. Cores, cursor, TUI do Claude,
redimensionamento automático, mouse/rolagem, colar, busca no histórico, reconexão automática.
- Abas: **Shell** (`bash` em `/root`, sessão `cr-shell`) e **uma por projeto** (`claude-<projeto>`),
  com bolinha de atividade (🟡 trabalhando · 🔴 esperando você · 🟢 ocioso).
- Linha de janelas do tmux: clique para alternar, **+** abre outra, **×** fecha; **assumir sessão**
  derruba outros clientes (quando o Console do EasyPanel travou o tamanho da tela).
- **Copiar/colar estilo PuTTY:** **selecionou com o mouse, copiou** (a seleção do tmux junta as
  linhas quebradas → URL longa sai inteira; chega ao navegador por OSC 52) · **`Ctrl+C`** com seleção
  copia, sem seleção interrompe (`^C`) · **`Ctrl+V`** / `Cmd+V` / botão direito / botão do meio colam ·
  `Ctrl+Shift+C/V` também · `Ctrl+Shift+F` busca · `Shift`+arrastar = seleção do navegador · roda rola.
- Botões: fonte ±, colar, limpar, **⌨ barra de teclas** (Esc/Tab/Ctrl+C/setas — celular),
  **arquivos ao lado** (split redimensionável), reconectar, **⛶ tela cheia** (`Shift+Esc` sai).
- Fechar a aba **não** encerra a sessão. Também dá pelo Console do EasyPanel: `tmux attach -t claude-<projeto>`.

### 3. Primeiro login do Claude
**Conta → Logar no Claude** (ou "deslogado — clique p/ logar" no Dashboard): o painel roda o `claude`
numa sessão própria (`cr-login`, 500 colunas → o link nunca quebra), **passa sozinho** pela tela de tema e
**seleciona "Claude account with subscription"**. Você só: **Abrir link** (ou **Copiar link**) → autoriza →
cola o código → **Conectar**. Fica salvo em `/root/.claude` (volume) e **não pede de novo**; projetos que
subiram antes do login e ficaram parados na tela de login são reiniciados sozinhos. Já logado, o mesmo
fluxo vira **Trocar de conta**. Telas inesperadas aparecem no modal com teclas (↑ ↓ Enter Esc).

> 🔓 **Permissões:** roda como usuário **não-root** (`ubuntu`) com política global em
> `/etc/claude-code/managed-settings.json` → `"defaultMode": "bypassPermissions"` +
> `"additionalDirectories": ["/root"]` — o Claude **permite tudo automaticamente** dentro de
> `/root`. Para voltar a pedir, edite/remova esse arquivo (no `claude/` do repo).

---

## 🧩 Painel "Claude Remote"

SPA em **React + Tailwind + react-router + xterm.js + CodeMirror** (Vite), servida pelo
`panel/server.js` (Node; deps de runtime: `ws` + `node-pty`). Código do servidor em
`panel/server/*.js`. **Tempo real por SSE** (`/api/events`): estado, atividade do Claude e
notificações chegam sem polling.

| Rota | O quê |
|------|-------|
| `/dashboard` | saúde do host (disco/RAM/load), versão do Claude Code (+ **atualizar**), cards dos projetos com atividade ao vivo, botão ⚙ abre o painel de configuração do projeto |
| `/terminal/shell` · `/terminal/<projeto>` | terminal real (acima) |
| `/files/<caminho>` | arquivos em `/root`: pasta → lista; arquivo → **editor CodeMirror** (highlight, Ctrl+S); criar/renomear/excluir inline; upload (botão/arrastar) e download |
| `/history/<projeto>` | **conversas do Claude** (lidas dos `.jsonl`): ver e **Continuar** (`claude --resume`) |
| `/report` | tokens e **custo estimado (US$)** por período, por dia, **por modelo** e por projeto |
| `/backup` | status do backup git por projeto, "backup agora", **snapshot/download da config** (`~/.claude`) |
| `/logs` | tail do log do painel, do backup e da **auditoria** (quem fez o quê), com filtro e auto-refresh |
| `/settings` | notificações, defaults do `panel.json`, ambiente do serviço (mascarado), caminhos |
| `/account` | conta do Claude (login OAuth/logout), **versão do Claude Code + atualizar**, **2FA (TOTP)**, **sessões ativas** do painel |

**Notificações:** o servidor observa cada sessão; quando o Claude **termina** (ficou ≥5 s trabalhando
e parou) ou **fica esperando você** (pergunta/permissão), o painel mostra um aviso e — se você
permitiu (🔔 no topo) — uma **notificação do navegador**, mesmo em segundo plano. Clique leva ao terminal.

**Segurança do painel:** login próprio com cookie de sessão **assinado, com expiração e revogável**
(`PANEL_SESSION_DAYS`; trocar a senha invalida tudo), **2FA TOTP** opcional (anti-replay),
comparação em tempo constante, **rate-limit** no login (8 falhas → 10 min), checagem de **Origin**
em POST/WebSocket (CSRF), CSP + headers de segurança, **audit log** em `~/.claude/logs/audit.log`.
Sem `PANEL_PASSWORD` o painel **recusa subir**. Se perder o 2FA: apague `~/.claude/.panel-totp.json`.

### Config por projeto (`panel.json`)
As flags por projeto ficam em **`/root/.claude/panel.json`** (cópia viva, no volume), semeada
de `claude/panel.json` (imagem) na 1ª subida. O painel grava nela; os scripts leem (via `devbox-lib.sh`):
- `enabled: false` → projeto **DESLIGADO** (chip **Ligado/Desligado** no Dashboard): sem sessão tmux, e
  continua assim no **restart do container** e no watchdog. **Ligar/Reiniciar** volta.
- `autoStartClaude: false` → a sessão fica só com um **shell** (chip **Claude ON/OFF** aplica **na hora**).
- `autoRemote: false` → **não** religa o remote-control nesse projeto (vale no próximo início do Claude).
- `initLine` → **primeira linha** enviada ao Claude em todo início (prompt inicial).
- O supervisor **relê** o `panel.json` a cada início do Claude: mudou no painel, vale sem recriar a sessão.
- Sem entrada própria → usa `defaults` (editáveis em **Configurações**).

---

## 🧩 tmux — sessão que não fecha
A sessão `claude-<projeto>` sobrevive a desconexões **e se auto-recupera**.

| Ação | Atalho/Comando |
|------|----------------|
| Entrar na sessão | painel → **Terminal** → aba do projeto · ou `tmux attach -t claude-<projeto>` |
| **Sair sem fechar** | `Ctrl+b` e depois `d` (no painel: só fechar a aba) |
| Listar sessões | `tmux ls` |
| Rolar a tela | roda do mouse (mouse ligado no `tmux.conf`) · ou `Ctrl+b` `[` (sai com `q`) |

### ♻️ Reabertura automática (respawn em 3 camadas)

| O que cai | Quem reabre | Tempo |
|-----------|-------------|-------|
| **Claude** (você deu `exit` ou crashou) | loop `while` no tmux reabre o `claude` | ~3s |
| **Sessão tmux** some (container vivo) | watchdog do `start.sh` recria a sessão (**só projetos ligados**) | ~10s |
| **Container** cai | EasyPanel reinicia → `start.sh` refaz tudo | conforme restart policy |

Ao (re)abrir o Claude, o supervisor (`claude-loop.sh`) **religa o remote-control sozinho**: espera a
TUI ficar pronta (lê a tela — sem depender de um sleep fixo), envia `/remote-control <projeto>`,
**confirma** que o link apareceu e **tenta até 3×**. Só se o projeto tiver `autoRemote: true` e o
Claude estiver logado. Manual: botão **Religar remote** (⚙ do projeto).

> 🐚 **Cair no shell de propósito:** `exit` e **`Ctrl+C`** na janela de 3s (`[claude saiu — reabrindo em 3s]`),
> ou **Claude OFF** no Dashboard. Log do supervisor (envio do remote etc.): **Logs → Sessões**.

---

## 💾 Persistência (o que NÃO some no redeploy)
- **Volume `claude-data` → `/root`**: seus **projetos**, login do Claude (`~/.claude`),
  `panel.json`, 2FA, sessões do painel, snapshots da config. 👉 **Trabalhe sempre dentro de `/root`.**
- **Imagem** (recriada a cada deploy): ubuntu, node, claude, playwright, painel
  buildado, ferramentas. O que estiver fora de `/root` volta ao estado da imagem.

---

## ⚙️ Variáveis (aba Environment do serviço)
Todas têm default no Dockerfile — o serviço sobe sem definir nada. Referência completa:
`claude/.env.example`. Visíveis (mascaradas) em **Configurações → Ambiente**.

| Variável | Default | O quê |
|----------|---------|-------|
| `PROJECT_FOLDER` | `projects` | projeto default (criado se o container subir sem nenhum) |
| `REMOTE_CONTROL_NAME` | (vazio) | vazio → remote usa o **nome do projeto**; defina p/ forçar um fixo |
| `CLAUDE_AUTOCMD_DELAY` | `15` | segundos mínimos antes de tentar o remote-control |
| `GH_TOKEN` | (vazio) | token GitHub (escopo `repo`) → auto-login do `gh` + push do backup |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `claude-devbox` / `devbox@easypanel.local` | identidade dos commits de backup |
| `BACKUP_ENABLED` | `true` | liga/desliga o backup automático dos projetos |
| `BACKUP_INTERVAL` | `3600` | intervalo entre backups (segundos) |
| `CONFIG_BACKUP_INTERVAL` | `86400` | snapshot da config (`~/.claude`) em `/root/.claude-backups` |
| `PANEL_ENABLED` | `true` | liga/desliga o painel |
| `GATEWAY_PORT` | `8080` | **porta pública** do gateway (aponte o domínio pra ela) |
| `PROJECTS_DIR` | `/root/projects` | diretório com as pastas de projeto |
| **`PANEL_LOGIN`** | `admin` | **usuário do login do painel** |
| **`PANEL_PASSWORD`** | (vazio) | **senha do login do painel**. Vazio → o boot **gera uma forte**, salva em `/root/.claude/.panel-password` e mostra no log |
| `PANEL_SESSION_DAYS` | `30` | validade da sessão do painel (dias) |

---

## 🛠️ Toolchain incluído
`claude-code` (versão pinada: `CLAUDE_CODE_VERSION`) · `playwright` (`PLAYWRIGHT_VERSION`; browsers
em `PLAYWRIGHT_BROWSERS`, default `chromium chrome`) · node 22 · npm/pnpm/yarn/bun · git · `gh` ·
ripgrep · fd · jq · tree · build-essential · python3/pip/venv · `psql` · tmux · caddy.

No Playwright, use o Chrome real com `channel: 'chrome'`. Mais browsers: `playwright install firefox webkit`.

---

## 🔁 Deploy / atualizações
- **Instalar no EasyPanel:** Create Service → **App** `claude` · Source Git (este repo, ramo
  `main`, **build path `/claude`**, Dockerfile) · **Armazenamento → Volume** `claude-data` →
  `/root` · **Domínios** → porta **`8080`** · Deploy.
- **Imagem self-contained, multi-stage:** o painel é buildado numa stage Node (`npm ci && npm run
  build && npm prune --omit=dev`, compila o `node-pty`) e só o resultado entra na imagem final. Versões
  do Claude Code/Playwright são **pinadas por `ARG`** — para subir, mude o `ARG` no Dockerfile e faça
  redeploy (ou use **Atualizar** no painel para a instalação viva, até o próximo redeploy).
- **Dev local do painel:** `cd claude/panel && npm install && npm run dev` (Vite na 5173 com proxy
  de `/api` e `/ws` para um `node server.js` na 7001 — precisa de tmux, i.e. Linux/WSL).
  Testes: `npm test` (smoke test do servidor; com tmux instalado testa o PTY real).
- **CI** (`.github/workflows/ci.yml`): shellcheck dos scripts, build do painel, smoke test com tmux.
- No dia a dia você **não precisa redeployar** — o container fica vivo e o trabalho está no
  volume. Redeploy só para **atualizar a imagem** (scripts/painel/ferramentas).

> ⚠️ Não use imagem base no GHCR: o build do EasyPanel puxa anonimamente e um package privado
> dá `401`. O modelo self-contained evita isso.

---

## 🚚 Fluxo de entrega (validar → PR → deploy)
1. Trabalhe numa branch (`fix/…`, `feat/…`, `chore/…`), nunca direto na `main`.
2. Valide antes de subir: `cd claude/panel && npm ci && npm run check && npm run build && npm test`
   (no macOS: `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` antes do teste) e
   `cd claude && shellcheck -S warning *.sh`. Mudou Dockerfile/boot: `docker build` + container em
   localhost (Mac ARM: `--build-arg PLAYWRIGHT_BROWSERS=chromium`).
3. PR para `main`. **Deploy = merge na `main`**: o webhook do EasyPanel no repo dispara o build do
   serviço sozinho. Confira no rodapé do painel (versão + build) que o deploy novo subiu.

> Armadilhas já encontradas: em `node -e 'script' a b` os argumentos começam em `process.argv[1]`;
> alvo tmux sempre exato (`=sessao:`, senão casa por prefixo); `capture-pane -J` para URLs longas;
> a regra de default do `panel.json` tem de ser igual em `devbox-lib.sh` e `server/projects.js`.

---

## 🔐 Segurança — IP allowlist
O filtro de IP **não** fica no container (o proxy do EasyPanel mascara o IP real, que chega em
`X-Forwarded-For`). Configure a allowlist na **aba Segurança do serviço `claude`**.

- **Hoje:** `0.0.0.0/0` (aberto — credenciais + 2FA protegem).
- **Restringir:** adicione os CIDRs permitidos (ex.: `203.0.113.10/32`).

---

## 🔁 Backup
- **Projetos:** a cada `BACKUP_INTERVAL` s o container faz **commit + push** de cada repo git dentro de
  `/root/projects` que tenha remote `origin` + auth (`GH_TOKEN` ou `gh auth login`). Status e "backup
  agora" em **Backup**; log em **Logs → Backup**. `docs/worklog` nunca entra no snapshot automático.
- **Config** (`~/.claude` + `~/.claude.json` = login, panel.json, 2FA, sessões): snapshot diário em
  `/root/.claude-backups` (mantém 7) e **download** pelo painel. Está no mesmo volume — **baixe de tempos
  em tempos**. Restaurar: `tar xzf config-….tgz -C /root` e reiniciar o serviço.

---

## 🗂️ Arquivos (em `claude/`)
| Arquivo | Papel |
|---------|-------|
| `Dockerfile` | imagem self-contained multi-stage (toolchain + painel), versões pinadas por `ARG` |
| `start.sh` | entrypoint: settings, sessões tmux, watchdog, backups, gateway Caddy |
| `devbox-lib.sh` | biblioteca comum dos scripts (`/usr/local/lib/devbox/lib.sh`): leitura do `panel.json`, nome da sessão, login |
| `claude-session.sh` | garante a sessão tmux de um projeto (`--all` = todos os ligados), honrando o `panel.json` |
| `claude-loop.sh` | supervisor: roda o Claude em loop relendo o `panel.json`, religa o remote (com confirmação), `--resume` a pedido do painel |
| `backup.sh` | commit+push dos projetos · `--config` = snapshot da config |
| `panel/` | painel **Claude Remote**: `server.js` + `server/*.js` (API, SSE, terminal WS/PTY, 2FA…) + `src/` (React) + `test/smoke.mjs` |
| `panel.json` | semente da config por projeto |
| `tmux.conf` | config global do tmux (`/etc/tmux.conf`): truecolor, mouse, clipboard (OSC 52), `window-size latest`, status |
| `managed-settings.json` | política global de permissões do Claude |
| `.env.example` | referência das variáveis (defaults da imagem) |
