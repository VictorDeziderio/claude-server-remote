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

## Acessar o IDE
Abra o domínio do serviço (ex.: `https://tools-claude.<...>.easypanel.host`) →
senha = variável **`PASSWORD`** (default no Dockerfile; troque no campo **Environment**).
No terminal integrado do VS Code rode:
```bash
claude            # inicia o Claude Code (primeira vez pede login/API key)
```

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
