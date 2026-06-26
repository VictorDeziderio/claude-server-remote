# claude — Ubuntu server com Claude Code + Playwright (EasyPanel)

Sandbox/dev-box persistente: Ubuntu 24.04 + Node 22 + **Claude Code CLI** + **Playwright**
(browser chromium + deps de SO), mantido vivo (`sleep infinity`). Acesse pelo **Console**
do EasyPanel e rode `claude`.

Browsers do Playwright ficam em `/opt/ms-playwright` (fora de `/root`, para o volume
persistente não os esconder). Para adicionar firefox/webkit: `playwright install firefox webkit`.

## Deploy no EasyPanel (projeto `tools`, serviço `claude`)

1. **Create Service → App**, nome `claude`.
2. **Source → Git:** este repo · ramo `main` · **Build path:** `/claude` ·
   **Builder:** Dockerfile (`Dockerfile`).
3. **Mounts → Add Volume** (NÃO bind mount):
   - **Volume name:** `claude-data`
   - **Mount path:** `/root`
   - > Volume do EasyPanel persiste entre deploys (o bind mount no diretório do código é
   >   apagado no git sync). Por isso usamos **Volume**.
4. **Deploy.** O container fica vivo aguardando.

## Usar

No **Console** do serviço:
```bash
claude            # inicia o Claude Code
```
Primeira vez pede login/API key. Como `/root` é volume persistente, o login
(`~/.claude`) e seus arquivos **não somem** no redeploy.

> Auth: rode `claude` e siga o login, ou defina `ANTHROPIC_API_KEY` no campo
> **Environment** do serviço.

## Persistência (não perde dados no redeploy)
- **Imagem** (sempre recriada no deploy): ubuntu, node, claude, playwright, ferramentas.
- **Volume em `/root`** (persiste): **seus projetos**, **login/config do Claude**
  (`~/.claude`), histórico de shell. Trabalhe sempre dentro de `/root`.
- Como é um **Volume do EasyPanel** (não bind mount), os dados **sobrevivem** a cada
  "Implantar". Só o que estiver fora de `/root` volta ao estado da imagem.

## Notas
- Não expõe portas (é um shell, não um web service) — sem domínio.
- Toolchain incluso: git, gh (GitHub CLI), ripgrep, fd, jq, build-essential, python3,
  node 22, playwright (chromium).
