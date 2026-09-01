# Claude Remote — Dev-box (painel + Claude Code + Playwright) no EasyPanel

Ubuntu 24.04 com um **painel "Claude Remote"** (React) para gerenciar projetos +
**Claude Code CLI** rodando em **tmux** + **Playwright** + toolchain de dev completo.
Persistente: seus projetos e o login do Claude **não somem** no redeploy.

Acesso por **uma porta só** (gateway Caddy = `GATEWAY_PORT`, default **8080**):
- **Painel:** `https://<domínio>/` — **página de login** (`PANEL_LOGIN` + `PANEL_PASSWORD`)
- **Projeto/serviço EasyPanel:** `meu-projeto` / `claude` · ex.: `https://claude.exemplo.easypanel.host`

> 🔌 **Porta de acesso:** aponte o domínio do serviço no EasyPanel para a **`GATEWAY_PORT` (8080)**.
> Internamente o painel roda em `127.0.0.1:7001` (não exposto).

---

## 🚀 Como usar (passo a passo)

### 1. Entrar no painel
Abra `https://<domínio>/` → aparece a **tela de login do Claude Remote**. Entre com
**`PANEL_LOGIN`** (default `admin`) e a senha **`PANEL_PASSWORD`**. O painel mostra status,
consumo de tokens e seus projetos.

### 2. Terminal — igual a um SSH, no navegador
Menu **Terminal** (ou `https://<domínio>/terminal/<projeto>`). É um terminal **de verdade**:
**xterm.js ↔ WebSocket ↔ PTY (`node-pty`) ↔ `tmux attach`**. Cores, cursor, TUI do Claude,
redimensionamento automático, mouse/rolagem, colar, reconexão automática. Abas na barra:
- **Shell** → `bash` em `/root` (sessão `cr-shell`, criada sob demanda)
- **&lt;projeto&gt;** → a sessão `claude-<projeto>` onde o Claude já está rodando

Atalhos: `Ctrl+Shift+C` copia · `Ctrl+Shift+V` cola · `Shift`+arrastar seleciona ·
roda do mouse rola o histórico · botão **⛶** tela cheia (`Shift+Esc` sai) · botão **⌨** liga a
barra de teclas (Esc/Tab/Ctrl+C/setas — útil no celular). Fechar a aba **não** encerra a sessão.

Também dá pelo **Console** do EasyPanel: `tmux attach -t claude-<projeto>`.

### 3. Primeiro login do Claude
**Conta → Logar no Claude**: abre um terminal embutido, roda `claude`, detecta o link OAuth
na tela (botão para abrir) e você cola o código. Depois fica salvo em `/root/.claude` (volume)
e **não pede de novo** nos próximos deploys.

> 🔓 **Permissões:** roda como usuário **não-root** (`ubuntu`) com política global em
> `/etc/claude-code/managed-settings.json` → `"defaultMode": "bypassPermissions"` +
> `"additionalDirectories": ["/root"]` — o Claude **permite tudo automaticamente** dentro de
> `/root`, sem pedir confirmação. Para voltar a pedir, edite/remova esse arquivo (no `claude/` do repo).

---

## 🧩 Painel "Claude Remote"

SPA em **React + Tailwind + react-router + xterm.js** (Vite), servida pelo `panel/server.js`
(Node; deps de runtime: `ws` + `node-pty`) que expõe a **API JSON** em `/api/*` e o
**terminal em `/ws/term`** (WebSocket). Código do servidor em `panel/server/*.js`
(`auth`, `projects`, `files`, `term`, `usage`, `claude`, `static`).

**Rotas com URL própria** (F5 e link direto funcionam):

| Rota | O quê |
|------|-------|
| `/dashboard` | status, consumo, cards dos projetos |
| `/report` | relatório de tokens por período/projeto |
| `/files/<caminho>` | gerenciador de arquivos (pasta → lista, arquivo → editor) |
| `/terminal/shell` · `/terminal/<projeto>` | terminal real (tmux attach) |
| `/account` | conta do Claude (login OAuth / logout) |

Recursos:
- **Status:** sessão tmux (de pé/fora), Claude (rodando/parado), login, versão, comando do remote, link do remote.
- **Consumo de tokens:** hoje vs total (entrada/saída/cache), lido de `~/.claude/projects/**/*.jsonl`.
- **Projetos** (cards): criar (`mkdir` + `git init` + grava config), **renomear** (renomeia a pasta
  **+ migra o histórico do Claude** + recria a sessão), **excluir** (digitando o nome),
  **reiniciar sessão**, **religar remote**, **primeira linha**.
- **Config por projeto** (chips): **🤖 Claude ON/OFF** (`autoStartClaude`) e **📡 Remote ON/OFF** (`autoRemote`).
- **Arquivos:** navegar `/root`, editar (Ctrl+S), criar, renomear, excluir, **download** e
  **upload** (botão ou arrastar). Confinado a `/root` (path traversal bloqueado).

**Segurança do painel:** login próprio com cookie de sessão **assinado e com expiração**
(`PANEL_SESSION_DAYS`; trocar a senha invalida todas as sessões), comparação em tempo constante,
**rate-limit** no login (8 falhas → 10 min), checagem de **Origin** em POST/WebSocket (CSRF),
CSP + headers de segurança. Sem `PANEL_PASSWORD` o painel **recusa subir**.

### Config por projeto (`panel.json`)
As flags por projeto ficam em **`/root/.claude/panel.json`** (cópia viva, no volume), semeada
de `claude/panel.json` (imagem) na 1ª subida. O painel grava nela; o `claude-session.sh` lê e
**honra as flags do projeto ativo**:
- `autoStartClaude: false` → a sessão sobe só com um **shell** (não inicia o Claude).
- `autoRemote: false` → **não** religa o remote-control nesse projeto.
- Sem entrada própria → usa `defaults` do `panel.json` (ON/ON).

---

## 🧩 tmux — sessão que não fecha
A sessão `claude` sobrevive a desconexões do terminal **e se auto-recupera**.

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
| **Sessão tmux** some (container vivo) | watchdog do `start.sh` recria a sessão | ~10s |
| **Container** cai | EasyPanel reinicia → `start.sh` refaz tudo | conforme restart policy |

Ao (re)abrir o Claude, o supervisor (`claude-loop.sh`) **religa o remote-control sozinho**
(comando fixo `/remote-control` + `REMOTE_CONTROL_NAME`, após o delay, **se o projeto tiver
`autoRemote: true` e o Claude estiver logado**). Forçar manual: `/remote-control meu-servidor`, ou o
botão **"Religar remote"** do painel.

> 🐚 **Cair no shell de propósito:** `exit` e **`Ctrl+C`** na janela de 3s (`[claude saiu — reabrindo em 3s]`).

---

## 💾 Persistência (o que NÃO some no redeploy)
- **Volume `claude-data` → `/root`**: seus **projetos**, login do Claude (`~/.claude`),
  `panel.json` vivo. 👉 **Trabalhe sempre dentro de `/root`.**
- **Imagem** (recriada a cada deploy): ubuntu, node, claude, playwright, painel
  buildado, ferramentas. O que estiver fora de `/root` volta ao estado da imagem.

---

## ⚙️ Variáveis (aba Environment do serviço)
Todas têm default no Dockerfile — o serviço sobe sem definir nada. Referência completa:
`claude/.env.example`.

| Variável | Default | O quê |
|----------|---------|-------|
| `PROJECT_FOLDER` | `projects` | pasta (em `/root`) onde o Claude inicia (criada se faltar) |
| `REMOTE_CONTROL_NAME` | `meu-servidor` | nome anexado ao comando → `/remote-control meu-servidor` |
| `CLAUDE_AUTOCMD_DELAY` | `15` | segundos antes de enviar o remote-control |
| `GH_TOKEN` | (vazio) | token GitHub (escopo `repo`) → auto-login do `gh` + push do backup |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `claude-devbox` / `devbox@easypanel.local` | identidade dos commits de backup |
| `BACKUP_ENABLED` | `true` | liga/desliga o backup automático |
| `BACKUP_INTERVAL` | `3600` | intervalo entre backups (segundos) |
| `PANEL_ENABLED` | `true` | liga/desliga o painel |
| `GATEWAY_PORT` | `8080` | **porta pública** do gateway (aponte o domínio pra ela) |
| `PROJECTS_DIR` | `/root/projects` | diretório com as pastas de projeto |
| **`PANEL_LOGIN`** | `admin` | **usuário do login do painel** |
| **`PANEL_PASSWORD`** | (hex) | **senha do login do painel** — TROQUE por uma forte |
| `PANEL_SESSION_DAYS` | `30` | validade da sessão do painel (dias) |

> O comando do remote-control é **fixo** (`/remote-control`); **ligar/desligar é por projeto**
> no painel (`panel.json` → `autoRemote`).

---

## 🛠️ Toolchain incluído
`claude-code` · `playwright` (chromium + **Google Chrome** estável) · node 22 · npm/pnpm/yarn/bun ·
git · `gh` · ripgrep · fd · jq · tree · build-essential · python3/pip/venv · `psql` · tmux · caddy.

No Playwright, use o Chrome real com `channel: 'chrome'`. Mais browsers: `playwright install firefox webkit`.

---

## 🔁 Deploy / atualizações
- **Instalar no EasyPanel:** Create Service → **App** `claude` · Source Git (este repo, ramo
  `main`, **build path `/claude`**, Dockerfile) · **Armazenamento → Volume** `claude-data` →
  `/root` · **Domínios** → porta **`8080`** · Deploy.
- **Imagem self-contained:** o `Dockerfile` builda **todo o toolchain** + **o painel React**
  (`npm ci && npm run build && npm prune --omit=dev`) no próprio build — **sem dependência de
  registry externo**. Ficam só `ws` + `node-pty` (compilado ali mesmo) em runtime. Por isso o
  deploy leva alguns minutos; em compensação, **sempre funciona sem credencial**.
- **Dev local do painel:** `cd claude/panel && npm install && npm run dev` (Vite na 5173 com
  proxy de `/api` e `/ws` para um `node server.js` na 7001 — precisa de tmux, i.e. Linux/WSL).
- No dia a dia você **não precisa redeployar** — o container fica vivo e o trabalho está no
  volume. Redeploy só para **atualizar a imagem** (scripts/painel/ferramentas).

> ⚠️ Não use imagem base no GHCR: o build do EasyPanel puxa anonimamente e um package privado
> dá `401`. O modelo self-contained evita isso.

---

## 🔐 Segurança — IP allowlist
O filtro de IP **não** fica no container (o proxy do EasyPanel mascara o IP real, que chega em
`X-Forwarded-For`). Configure a allowlist na **aba Segurança do serviço `claude`**.

- **Hoje:** `0.0.0.0/0` (aberto — só as credenciais protegem).
- **Restringir:** adicione os CIDRs permitidos (ex.: `203.0.113.10/32`).

> Enquanto estiver `0.0.0.0/0`, a única barreira é o **login do painel**
> — use uma senha forte. O Claude roda com permissão total restrita a `/root`.

---

## 🔁 Backup automático dos projetos
A cada `BACKUP_INTERVAL` segundos (default 1h), o container faz **commit + push** de cada repo
git dentro de `/root/$PROJECT_FOLDER`. Requisitos por projeto:

1. ser um **repo git** com **remote `origin`** configurado;
2. ter **auth de push** — `GH_TOKEN` (escopo `repo`) ou `gh auth login` uma vez.

Repos sem `origin` são ignorados (log). Log: `/root/.claude/logs/backup.log`. Manual:
`bash /usr/local/bin/backup.sh`. Desligar: `BACKUP_ENABLED=false`.

---

## 🗂️ Arquivos (em `claude/`)
| Arquivo | Papel |
|---------|-------|
| `Dockerfile` | imagem self-contained (toolchain + build do painel) |
| `start.sh` | entrypoint: settings, sessão tmux, watchdog, backup, gateway Caddy |
| `claude-session.sh` | (re)cria a sessão tmux na pasta ativa, honrando o `panel.json` |
| `claude-loop.sh` | supervisor: roda o Claude em loop + religa o remote |
| `backup.sh` | commit+push periódico dos projetos |
| `panel/` | painel **Claude Remote** (React/Vite/xterm.js + `server.js` + `server/*.js`: API, arquivos, terminal WS/PTY) |
| `panel.json` | semente da config por projeto (`autoStartClaude`/`autoRemote`) |
| `tmux.conf` | config global do tmux (`/etc/tmux.conf`): truecolor, mouse, `window-size latest`, status |
| `managed-settings.json` | política global de permissões do Claude |
| `.env.example` | referência das variáveis (defaults da imagem) |
