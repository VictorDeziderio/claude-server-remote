# claude — Dev-box (IDE web + Claude Code + Playwright) no EasyPanel

Ubuntu 24.04 com **code-server (VS Code no navegador)** + **Claude Code CLI** +
**Playwright** + toolchain de dev completo. Acesso pelo navegador (IDE com terminal
integrado) e pelo Console do EasyPanel.

## Deploy no EasyPanel (projeto `tools`, serviço `claude`)

1. **Create Service → App**, nome `claude`.
2. **Source → Git:** este repo · ramo `main` · **Build path:** `/claude` · Dockerfile.
3. **Armazenamento → Adicionar Montagem de Volume:** `claude-data` → `/root`
   (Volume do EasyPanel, **persiste** no redeploy — não use bind mount).
4. **Domínios:** aponte um domínio para a **porta `8080`** (o code-server).
5. **Deploy.**

## Variáveis (campo Environment do EasyPanel)
| Variável | Valor | O quê |
|----------|-------|-------|
| `IDE_ENABLED` | `true` / `false` | habilita/desabilita o IDE web |
| `PASSWORD` | senha | senha de acesso ao IDE (code-server tem só senha, sem usuário) |

> Para usuário+senha de verdade, ative o **basic-auth** na aba **Segurança** do serviço.

## Acessar o IDE
Abra o domínio do serviço (ex.: `https://tools-claude.<...>.easypanel.host`) →
senha = **`PASSWORD`**. No terminal integrado do VS Code:
```bash
tmux attach -t claude   # entra na sessão persistente do Claude Code
# (ou inicie outra: `claude`)
```

## tmux — sessão que não fecha
Na subida, o container já cria uma sessão **tmux `claude`** rodando o Claude Code. Ela
**sobrevive** a desconexões do IDE/terminal (só reinicia se o container reiniciar).
- Entrar: `tmux attach -t claude`
- Sair sem fechar: `Ctrl+b` depois `d`
- Funciona tanto no terminal do IDE quanto no **Console** do EasyPanel.

## Persistência (não perde dados no redeploy)
- **Imagem** (recriada no deploy): code-server, claude, playwright, node, ferramentas.
- **Volume em `/root`** (persiste): projetos, login do Claude (`~/.claude`), config/extensões
  do VS Code (`~/.config/code-server`, `~/.local/share/code-server`).

## Toolchain incluído
node 22 · npm/pnpm/yarn/bun · git · gh (GitHub CLI) · ripgrep · fd · jq · tree ·
build-essential · python3/pip/venv · postgresql-client (`psql`) · playwright (chromium) ·
claude-code · code-server.

> 🔒 O IDE fica num domínio público com senha. Use uma senha forte (`PASSWORD` no
> Environment) e considere IP-restriction/basic-auth do EasyPanel para mais segurança.
> Adicionar mais browsers Playwright: `playwright install firefox webkit`.
