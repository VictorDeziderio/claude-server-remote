# claude — Dev-box (IDE web + Claude Code + Playwright) no EasyPanel

Ubuntu 24.04 com **code-server (VS Code no navegador)** + **Claude Code CLI** rodando em
**tmux** + **Playwright** + toolchain de dev completo. Persistente: seus projetos e o login
do Claude **não somem** no redeploy.

Acesso por **uma porta só** (gateway Caddy), com **login único** (usuário `PANEL_USER` + senha `PANEL_PASSWORD`):
- **Painel:** https://tools-claude.exemplo.easypanel.host/ (raiz)
- **IDE:** https://tools-claude.exemplo.easypanel.host/ide (botão "Abrir IDE" no painel)
- **Projeto/serviço EasyPanel:** `tools` / `claude`

---

## 🚀 Como usar (passo a passo)

### 1. Abrir o painel / o IDE
Abra **https://tools-claude.exemplo.easypanel.host** → no login use **`PANEL_USER`** (default `admin`)
e a senha **`PANEL_PASSWORD`**. A raiz mostra o **painel**; clique em **"Abrir IDE"** (ou vá em
**`/ide`**). Um login só libera os dois.

### 2. Abrir um terminal
No VS Code: menu **Terminal → New Terminal** (atalho `` Ctrl+` ``).
> Alternativa: no serviço `claude` no EasyPanel, botão **"Console"**.

### 3. Entrar na sessão do Claude (tmux)
```bash
tmux attach -t claude
```
O Claude Code já está rodando nessa sessão. Os dois caminhos (IDE e Console) entram na
**mesma** sessão.

### 4. Primeiro login do Claude
Na 1ª vez, o Claude estará na tela de **login** (API key ou conta). Depois de logar, fica
salvo em `/root/.claude` (volume) e **não pede de novo** nos próximos deploys.

> 🔓 **Permissões (global no server):** roda como usuário **não-root** (`ubuntu`) e há uma
> **política global** em `/etc/claude-code/managed-settings.json` com
> `"defaultMode": "bypassPermissions"` — o Claude **permite tudo automaticamente** (não pede
> confirmação) para **qualquer usuário/projeto** no container, sem precisar de flag.
> (Há também um `~/.claude/settings.json` por usuário, mas a política global tem precedência.)
> Para voltar a pedir confirmação, edite/remova o `managed-settings.json` (no `claude/` do repo).

---

## 🧩 tmux — sessão que não fecha
A sessão `claude` sobrevive a desconexões do IDE/terminal **e se auto-recupera** se algo cair.
Comandos:

| Ação | Atalho/Comando |
|------|----------------|
| Entrar na sessão | `tmux attach -t claude` |
| **Sair sem fechar** (Claude continua rodando) | `Ctrl+b` e depois `d` |
| Listar sessões | `tmux ls` |
| Rolar a tela | `Ctrl+b` e depois `[` (sai com `q`) |
| Nova sessão | `tmux new -s nome` |

### ♻️ Reabertura automática (respawn em 3 camadas)
O Claude roda dentro de um loop e a sessão tem um watchdog — então ele **volta sozinho**:

| O que cai | Quem reabre | Tempo |
|-----------|-------------|-------|
| **Claude** (você deu `exit` ou ele crashou) | loop `while` no tmux reabre o `claude` | ~3s |
| **Sessão tmux** some (container ainda vivo) | watchdog do `start.sh` recria a sessão | ~10s |
| **Container / code-server** cai | EasyPanel reinicia → `start.sh` refaz tudo | conforme restart policy |

Ao (re)abrir o Claude — no boot, no respawn ou quando o watchdog recria a sessão — o
supervisor (`claude-loop.sh`) **religa o remote-control sozinho** (envia o `CLAUDE_AUTOCMD`
após o delay, se logado). Para forçar manualmente: `/remote-control meu-servidor`.

> 🐚 **Quer cair no shell de propósito?** Dê `exit` e aperte **`Ctrl+C`** na janela de 3s
> (a mensagem `[claude saiu — reabrindo em 3s | Ctrl-C cancela]`). Sem o Ctrl+C, o Claude reabre.

---

## 💾 Persistência (o que NÃO some no redeploy)
- **Volume `claude-data` → `/root`** (persiste): **seus projetos**, login do Claude
  (`~/.claude`), config/extensões do VS Code, histórico do shell.
  👉 **Trabalhe sempre dentro de `/root`.**
- **Imagem** (recriada a cada deploy, sempre fresca): ubuntu, node, claude, playwright,
  code-server, ferramentas. O que estiver fora de `/root` volta ao estado da imagem.

---

## ⚙️ Variáveis (aba Environment do serviço)
| Variável | Default | O quê |
|----------|---------|-------|
| `IDE_ENABLED` | `true` | liga/desliga o IDE web |
| `IDE_PASSWORD` | (gerada) | senha de acesso ao IDE |
| `REMOTE_CONTROL_NAME` | `meu-servidor` | nome do remote-control, anexado ao comando (ex.: `/remote-control meu-servidor`) |
| `PROJECT_FOLDER` | `projects` | pasta (dentro de `/root`) onde o Claude inicia — **criada automaticamente se não existir** |
| `CLAUDE_AUTOCMD` | `/remote-control` | comando base no start; o nome vem de `REMOTE_CONTROL_NAME` (`""` desativa) |
| `CLAUDE_AUTOCMD_DELAY` | `15` | segundos antes de enviar o comando |
| `GH_TOKEN` | (vazio) | token GitHub (escopo `repo`) → auto-login do `gh` + push do backup |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `claude-devbox` / `devbox@easypanel.local` | identidade dos commits de backup |
| `BACKUP_ENABLED` | `true` | liga/desliga o backup automático dos projetos |
| `BACKUP_INTERVAL` | `3600` | intervalo entre backups (segundos) |
| `PANEL_ENABLED` | `true` | liga/desliga o painel de controle |
| `GATEWAY_PORT` | `8080` | porta pública do gateway (aponte o domínio pra ela) |
| `PANEL_USER` | `admin` | usuário do login (cobre painel e IDE) |
| `PANEL_PASSWORD` | (= `IDE_PASSWORD`) | senha do login do gateway |
| `PROJECTS_DIR` | `/root/projects` | diretório que contém as pastas de projeto |
| `IDE_PUBLIC_URL` | (vazio) | só se o IDE estiver num domínio próprio |

### 🔁 Auto-start (ao reiniciar)
No start, o container automaticamente: garante a pasta `/root/$PROJECT_FOLDER` (cria se faltar)
→ cria a sessão tmux `claude` nela → roda o `claude` **em loop** (reabre no `exit`/crash) +
sobe um **watchdog** (recria a sessão se ela cair) → após carregar, envia
`CLAUDE_AUTOCMD` + `REMOTE_CONTROL_NAME` (ex.: `/remote-control meu-servidor`).
É só `tmux attach -t claude` que já está rodando. (Detalhes do respawn na seção tmux acima.)
> ⚠️ O comando só dispara se **(1) `/login` feito** e **(2) Claude ativo**. Sem login/Claude
> parado → não envia (deixa normal). O supervisor (`claude-loop.sh`) reenvia o
> `CLAUDE_AUTOCMD` **a cada (re)início do Claude** — no boot, no respawn por `exit` e quando
> o watchdog recria a sessão — porque o `claude` sobe conversa nova e não reconecta o
> remote-control sozinho. Forçar manualmente: `/remote-control meu-servidor`.
> ⚠️ Na **1ª vez** o Claude pede login — faça uma vez (persiste em `/root/.claude`); nos
> próximos restarts o auto-comando funciona direto.

> O code-server usa **só senha** (sem usuário). Para usuário+senha, ative o **basic-auth**
> na aba **Segurança** do serviço.

---

## 🛠️ Toolchain incluído
`claude-code` · `playwright` (chromium + **Google Chrome** estável) · node 22 · npm/pnpm/yarn/bun ·
git · `gh` (GitHub CLI) · ripgrep · fd · jq · tree · build-essential · python3/pip/venv ·
`psql` (postgresql-client) · tmux · code-server.

No Playwright, use o Google Chrome real com `channel: 'chrome'` (senão usa o chromium bundled).
Adicionar mais browsers: `playwright install firefox webkit`.

---

## 🔁 Deploy / atualizações
- Só o **1º build** é lento (baixa tudo). Os próximos reusam o **cache do Docker** → rápidos.
- No dia a dia você **não precisa redeployar** — o container fica vivo e o trabalho está no
  volume. Redeploy só para **atualizar a imagem** (ex.: novas ferramentas no Dockerfile).
- Como instalar no EasyPanel: **Create Service → App** `claude` · Source Git (este repo,
  ramo `main`, build path `/claude`, Dockerfile) · **Armazenamento → Volume** `claude-data`
  → `/root` · **Domínios** → porta `8080` · Deploy.

> 🔒 O IDE fica num domínio público com senha. Use uma senha forte em `IDE_PASSWORD` e
> considere basic-auth/IP-restriction na aba Segurança.

---

## 🔐 Segurança — IP allowlist

O filtro de IP **não** fica no container: o code-server só enxerga o IP do proxy interno
do EasyPanel (o IP real do cliente chega no header `X-Forwarded-For`). Por isso a allowlist
é configurada na **aba Segurança do serviço `claude`** no EasyPanel.

- **Hoje:** `0.0.0.0/0` (aberto a todos — só a senha do IDE protege).
- **Para restringir:** adicione na aba Segurança os CIDRs permitidos (ex.: seu IP fixo
  `203.0.113.10/32`). Aí só esses IPs alcançam o domínio.

> Enquanto estiver `0.0.0.0/0`, a senha `IDE_PASSWORD` é a única barreira — mantenha-a forte.
> O Claude roda com permissão total (`bypassPermissions`), restrita ao diretório `/root`
> (`additionalDirectories: ["/root"]`).

---

## 🔁 Backup automático dos projetos

A cada `BACKUP_INTERVAL` segundos (default 1h), o container faz **commit + push** de cada
repositório git dentro de `/root/$PROJECT_FOLDER`. Para funcionar, cada projeto precisa:

1. ser um **repo git** (`git init`) com **remote `origin`** configurado (`git remote add origin <url>`);
2. ter **autenticação de push** — defina `GH_TOKEN` (escopo `repo`) ou rode `gh auth login` uma vez.

Repos sem `origin` são ignorados (registrados no log). Log: `/root/.claude/logs/backup.log`.
Backup manual a qualquer momento: `bash /usr/local/bin/backup.sh` (ou `backup.sh /root/projects/meu-projeto`).
Desligar: `BACKUP_ENABLED=false`.

---

## 🧩 Painel de controle

Um painel web leve (Node puro) pra gerenciar os projetos sem mexer no terminal:

- **Listar/criar pastas** de projeto em `PROJECTS_DIR` (`/root/projects`) — criar faz `mkdir` + `git init`.
- **🔄 Reiniciar aqui** — define a pasta como **ativa** e recria a sessão do Claude nela (~3s),
  sem derrubar IDE nem container. A pasta ativa fica em `/root/.claude/active-project` e é
  respeitada pelo boot e pelo watchdog.
- **🖥️ Abrir IDE** — abre o code-server já na pasta do projeto (precisa de `IDE_PUBLIC_URL`).

**Modelo:** um Claude por vez, apontando para a pasta ativa (não roda vários em paralelo).
**Auth:** mesma senha do IDE (`IDE_PASSWORD`). Log: `/root/.claude/logs/panel.log`.

### Acesso — uma porta só (gateway Caddy) + login único
Um **gateway (Caddy)** na porta **8080** publica tudo sob o mesmo domínio, com **um login só**:

| O quê | URL | Interno |
|-------|-----|---------|
| **Painel** | `https://<domínio>/` | Node em `127.0.0.1:7000` |
| **IDE** | `https://<domínio>/ide` | code-server em `127.0.0.1:8081` |

- **Login único (no env):** o gateway faz `basic_auth` — usuário **`PANEL_USER`** (default `admin`),
  senha **`PANEL_PASSWORD`** (se vazia, cai pra `IDE_PASSWORD`). Logou ao abrir o painel → o `/ide`
  já fica liberado (mesma sessão do navegador). O botão **"Abrir IDE"** do painel leva pra `/ide`.
- O painel e o code-server rodam **sem auth própria** (só o gateway autentica) e escutam só
  em `127.0.0.1` (não expostos direto). No EasyPanel, **um domínio → `GATEWAY_PORT`** (default 8080).
- Desligar painel: `PANEL_ENABLED=false`. Desligar IDE: `IDE_ENABLED=false`.

> ⚠️ O IDE sob subpath (`/ide`) usa `--abs-proxy-base-path=/ide` no code-server. É um caminho
> suportado, porém mais sensível que servir na raiz — se algum asset/preview do IDE falhar,
> me avise que ajusto a regra do gateway.
