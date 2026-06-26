# claude — Dev-box (IDE web + Claude Code + Playwright) no EasyPanel

Ubuntu 24.04 com **code-server (VS Code no navegador)** + **Claude Code CLI** rodando em
**tmux** + **Playwright** + toolchain de dev completo. Persistente: seus projetos e o login
do Claude **não somem** no redeploy.

- **IDE:** https://tools-claude.exemplo.easypanel.host (senha = variável `PASSWORD`)
- **Projeto/serviço EasyPanel:** `tools` / `claude`

---

## 🚀 Como usar (passo a passo)

### 1. Abrir o IDE
Abra **https://tools-claude.exemplo.easypanel.host** → digite a senha (`PASSWORD` do Environment).
Abre o VS Code no navegador, já no diretório `/root`.

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
A sessão `claude` sobrevive a desconexões do IDE/terminal (só reinicia se o container
reiniciar). Comandos:

| Ação | Atalho/Comando |
|------|----------------|
| Entrar na sessão | `tmux attach -t claude` |
| **Sair sem fechar** (Claude continua rodando) | `Ctrl+b` e depois `d` |
| Listar sessões | `tmux ls` |
| Rolar a tela | `Ctrl+b` e depois `[` (sai com `q`) |
| Nova sessão | `tmux new -s nome` |

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
| `PASSWORD` | (gerada) | senha de acesso ao IDE |
| `PROJECT_FOLDER` | `projects` | pasta (dentro de `/root`) onde o Claude inicia — **criada automaticamente se não existir** |
| `CLAUDE_AUTOCMD` | `/remote-control easypanel` | comando enviado ao Claude no start (`""` desativa) |
| `CLAUDE_AUTOCMD_DELAY` | `15` | segundos antes de enviar o comando |

### 🔁 Auto-start (ao reiniciar)
No start, o container automaticamente: garante a pasta `/root/$PROJECT_FOLDER` (cria se faltar)
→ cria a sessão tmux `claude` nela → roda o `claude` → após carregar, envia `CLAUDE_AUTOCMD`
(ex.: `/remote-control easypanel`). É só `tmux attach -t claude` que já está rodando.
> ⚠️ Na **1ª vez** o Claude pede login — faça uma vez (persiste em `/root/.claude`); nos
> próximos restarts o auto-comando funciona direto.

> O code-server usa **só senha** (sem usuário). Para usuário+senha, ative o **basic-auth**
> na aba **Segurança** do serviço.

---

## 🛠️ Toolchain incluído
`claude-code` · `playwright` (chromium) · node 22 · npm/pnpm/yarn/bun · git · `gh` (GitHub CLI) ·
ripgrep · fd · jq · tree · build-essential · python3/pip/venv · `psql` (postgresql-client) ·
tmux · code-server.

Adicionar mais browsers Playwright: `playwright install firefox webkit`.

---

## 🔁 Deploy / atualizações
- Só o **1º build** é lento (baixa tudo). Os próximos reusam o **cache do Docker** → rápidos.
- No dia a dia você **não precisa redeployar** — o container fica vivo e o trabalho está no
  volume. Redeploy só para **atualizar a imagem** (ex.: novas ferramentas no Dockerfile).
- Como instalar no EasyPanel: **Create Service → App** `claude` · Source Git (este repo,
  ramo `main`, build path `/claude`, Dockerfile) · **Armazenamento → Volume** `claude-data`
  → `/root` · **Domínios** → porta `8080` · Deploy.

> 🔒 O IDE fica num domínio público com senha. Use uma senha forte em `PASSWORD` e
> considere basic-auth/IP-restriction na aba Segurança.
