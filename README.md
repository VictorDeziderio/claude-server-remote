# Claude Remote — Dev-box (painel + IDE web + Claude Code + Playwright) no EasyPanel

Ubuntu 24.04 com um **painel "Claude Remote"** (React) para gerenciar projetos +
**code-server (VS Code no navegador)** + **Claude Code CLI** rodando em **tmux** +
**Playwright** + toolchain de dev completo. Persistente: seus projetos e o login do Claude
**não somem** no redeploy.

Acesso por **uma porta só** (gateway Caddy = `GATEWAY_PORT`, default **8080**), com
**credenciais separadas**:
- **Painel:** `https://<domínio>/` — **página de login** (`PANEL_LOGIN` + `PANEL_PASSWORD`)
- **IDE:** `https://<domínio>/ide` — **token** (`IDE_TOKEN`, login nativo do code-server; link compartilhável)
- **Projeto/serviço EasyPanel:** `tools` / `claude` · ex.: `https://tools-claude.exemplo.easypanel.host`

> 🔌 **Porta de acesso:** aponte o domínio do serviço no EasyPanel para a **`GATEWAY_PORT` (8080)**.
> Internamente o painel roda em `127.0.0.1:7001` e o code-server em `:8081` (não expostos).

---

## 🚀 Como usar (passo a passo)

### 1. Entrar no painel
Abra `https://<domínio>/` → aparece a **tela de login do Claude Remote**. Entre com
**`PANEL_LOGIN`** (default `admin`) e a senha **`PANEL_PASSWORD`**. O painel mostra status,
consumo de tokens e seus projetos.

### 2. Abrir o IDE
No card do projeto, **"IDE"** (ou vá em `https://<domínio>/ide`). O IDE pede o **`IDE_TOKEN`**
(barreira própria do code-server) — independente do login do painel, então o link do IDE é
compartilhável sem dar acesso ao painel.

### 3. Terminal e sessão do Claude (tmux)
No VS Code: **Terminal → New Terminal** (`` Ctrl+` ``). Depois:
```bash
tmux attach -t claude
```
O Claude Code já está rodando nessa sessão. (Alternativa: botão **Console** do serviço no EasyPanel.)

### 4. Primeiro login do Claude
Na 1ª vez o Claude estará na tela de **login** (API key ou conta). Depois fica salvo em
`/root/.claude` (volume) e **não pede de novo** nos próximos deploys.

> 🔓 **Permissões:** roda como usuário **não-root** (`ubuntu`) com política global em
> `/etc/claude-code/managed-settings.json` → `"defaultMode": "bypassPermissions"` +
> `"additionalDirectories": ["/root"]` — o Claude **permite tudo automaticamente** dentro de
> `/root`, sem pedir confirmação. Para voltar a pedir, edite/remova esse arquivo (no `claude/` do repo).

---

## 🧩 Painel "Claude Remote"

SPA em **React + Tailwind** (Vite), servida pelo `panel/server.js` (Node puro) que também
expõe uma **API JSON** (`/api/state|create|rename|config|restart|remote|login|logout`).
O painel tem **página de login própria** (cookie de sessão assinado — sem popup do navegador).

Recursos:
- **Status:** sessão tmux (de pé/fora), Claude (rodando/parado + pane), login, versão, projeto ativo, comando do remote.
- **Consumo de tokens:** hoje vs total (entrada/saída/cache), lido de `~/.claude/projects/**/*.jsonl`.
- **Projetos** (cards): criar (`mkdir` + `git init` + grava config), **renomear** (renomeia a pasta
  **+ migra o histórico do Claude** + recria a sessão se for o ativo), **reiniciar sessão**,
  **religar remote**, **abrir IDE**.
- **Config por projeto** (chips): **🤖 Claude ON/OFF** (`autoStartClaude`) e **📡 Remote ON/OFF** (`autoRemote`).

### Config por projeto (`panel.json`)
As flags por projeto ficam em **`/root/.claude/panel.json`** (cópia viva, no volume), semeada
de `claude/panel.json` (imagem) na 1ª subida. O painel grava nela; o `claude-session.sh` lê e
**honra as flags do projeto ativo**:
- `autoStartClaude: false` → a sessão sobe só com um **shell** (não inicia o Claude).
- `autoRemote: false` → **não** religa o remote-control nesse projeto.
- Sem entrada própria → usa `defaults` do `panel.json` (ON/ON).

---

## 🧩 tmux — sessão que não fecha
A sessão `claude` sobrevive a desconexões do IDE/terminal **e se auto-recupera**.

| Ação | Atalho/Comando |
|------|----------------|
| Entrar na sessão | `tmux attach -t claude` |
| **Sair sem fechar** | `Ctrl+b` e depois `d` |
| Listar sessões | `tmux ls` |
| Rolar a tela | `Ctrl+b` e depois `[` (sai com `q`) |

### ♻️ Reabertura automática (respawn em 3 camadas)

| O que cai | Quem reabre | Tempo |
|-----------|-------------|-------|
| **Claude** (você deu `exit` ou crashou) | loop `while` no tmux reabre o `claude` | ~3s |
| **Sessão tmux** some (container vivo) | watchdog do `start.sh` recria a sessão | ~10s |
| **Container / code-server** cai | EasyPanel reinicia → `start.sh` refaz tudo | conforme restart policy |

Ao (re)abrir o Claude, o supervisor (`claude-loop.sh`) **religa o remote-control sozinho**
(comando fixo `/remote-control` + `REMOTE_CONTROL_NAME`, após o delay, **se o projeto tiver
`autoRemote: true` e o Claude estiver logado**). Forçar manual: `/remote-control meu-servidor`, ou o
botão **"Religar remote"** do painel.

> 🐚 **Cair no shell de propósito:** `exit` e **`Ctrl+C`** na janela de 3s (`[claude saiu — reabrindo em 3s]`).

---

## 💾 Persistência (o que NÃO some no redeploy)
- **Volume `claude-data` → `/root`**: seus **projetos**, login do Claude (`~/.claude`),
  `panel.json` vivo, config/extensões do VS Code. 👉 **Trabalhe sempre dentro de `/root`.**
- **Imagem** (recriada a cada deploy): ubuntu, node, claude, playwright, code-server, painel
  buildado, ferramentas. O que estiver fora de `/root` volta ao estado da imagem.

---

## ⚙️ Variáveis (aba Environment do serviço)
Todas têm default no Dockerfile — o serviço sobe sem definir nada. Referência completa:
`claude/.env.example`.

| Variável | Default | O quê |
|----------|---------|-------|
| `IDE_ENABLED` | `true` | liga/desliga o IDE web |
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
| **`IDE_TOKEN`** | (hex) | **token de acesso ao `/ide`** (senha do code-server) — TROQUE |

> O comando do remote-control é **fixo** (`/remote-control`); **ligar/desligar é por projeto**
> no painel (`panel.json` → `autoRemote`). Não há mais `CLAUDE_AUTOCMD`/`IDE_PASSWORD`/`PANEL_USER`.

---

## 🛠️ Toolchain incluído
`claude-code` · `playwright` (chromium + **Google Chrome** estável) · node 22 · npm/pnpm/yarn/bun ·
git · `gh` · ripgrep · fd · jq · tree · build-essential · python3/pip/venv · `psql` · tmux ·
code-server · caddy.

No Playwright, use o Chrome real com `channel: 'chrome'`. Mais browsers: `playwright install firefox webkit`.

---

## 🔁 Deploy / atualizações
- **Instalar no EasyPanel:** Create Service → **App** `claude` · Source Git (este repo, ramo
  `main`, **build path `/claude`**, Dockerfile) · **Armazenamento → Volume** `claude-data` →
  `/root` · **Domínios** → porta **`8080`** · Deploy.
- **Imagem self-contained:** o `Dockerfile` builda **todo o toolchain** + **o painel React**
  (`npm ci && npm run build`) no próprio build — **sem dependência de registry externo**. Por isso
  o deploy leva alguns minutos (instala toolchain + dependências do painel); em compensação,
  **sempre funciona sem credencial**.
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

> Enquanto estiver `0.0.0.0/0`, as únicas barreiras são o **login do painel** e o **token do IDE**
> — use senha/token fortes. O Claude roda com permissão total restrita a `/root`.

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
| `panel/` | painel **Claude Remote** (React/Vite + `server.js` API/estático) |
| `panel.json` | semente da config por projeto (`autoStartClaude`/`autoRemote`) |
| `managed-settings.json` | política global de permissões do Claude |
| `.env.example` | referência das variáveis (defaults da imagem) |
