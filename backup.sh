#!/usr/bin/env bash
# Backup automatico dos projetos: percorre cada repo git dentro de
# $PROJECTS_DIR e faz add + commit (se houver mudanca) + push (best-effort). Repos sem
# remote 'origin' sao ignorados (com aviso no log). A autenticacao do push usa
# o gh/GH_TOKEN configurado no start.sh (gh auth setup-git).
#
# Uso:
#   backup.sh            -> uma passada em TODOS os projetos de $PROJECTS_DIR
#   backup.sh /caminho   -> backup so desse repo
#   backup.sh --config   -> tarball da CONFIG (~/.claude sem historico/logs + ~/.claude.json)
#                           em $H/.claude-backups/config-<data>.tgz (mantem os 7 mais recentes).
#                           Baixe pelo painel (Backup) — se o volume sumir, o login/config vao junto.
#
# Roda como o usuario "ubuntu" (HOME=/root, volume). Identidade git e definida
# no start.sh (ou cai num default local aqui).
set -uo pipefail   # sem -e: um repo que falha nao aborta os demais

H="${HOME:-/root}"
# a MESMA pasta de projetos do painel/sessoes (antes usava /root/$PROJECT_FOLDER, que so
# coincidia com o default; com PROJECT_FOLDER=outro o backup varria a pasta errada)
PROJECTS_DIR="${PROJECTS_DIR:-$H/projects}"
LOG_DIR="$H/.claude/logs"
LOG="$LOG_DIR/backup.log"
CFG_BACKUP_DIR="$H/.claude-backups"
CFG_KEEP="${CONFIG_BACKUP_KEEP:-7}"
mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%F %T')] $*" | tee -a "$LOG"
  # sem logrotate neste dev-box: backup.log roda pra sempre e cresceria sem teto ate
  # faltar disco. Trunca sozinho acima de ~5MB, mantendo so o final (achado @qa).
  if [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

# Duas chamadas ao mesmo tempo (loop automatico + "backup agora" do painel, ou o loop de
# projetos e o de config disparando juntos) rodariam git add/commit/push no MESMO repo em
# paralelo -> corrida no indice do git. Lock nao-bloqueante: se ja tem um backup rodando,
# so pula esta passada (ela volta no proximo intervalo/clique) em vez de empilhar.
exec 9>"$LOG_DIR/backup.lock"
if ! flock -n 9; then
  log "skip: outro backup.sh ja em execucao"
  exit 0
fi

# alert() e RUN_DIR vem da lib comum; sem ela (teste fora da imagem) os alertas so nao saem
# shellcheck source=devbox-lib.sh
. "${DEVBOX_LIB:-/usr/local/lib/devbox/lib.sh}" 2>/dev/null || alert() { :; }
# memoria da VM no limite (guarda do start.sh): tar/git agora so piorariam -- pula esta passada
if [ -e "${RUN_DIR:-$H/.claude/run}/lowmem" ]; then
  log "skip: memoria alta (lowmem) — backup adiado"
  exit 0
fi

backup_config() {
  mkdir -p "$CFG_BACKUP_DIR"
  local out stamp
  # +PID: dois disparos no mesmo segundo (job automatico + clique manual) nao colidem
  # no nome do arquivo e um nao sobrescreve o outro em silencio (achado @qa 2026-09-28)
  stamp="$(date '+%Y%m%d-%H%M%S')-$$"
  out="$CFG_BACKUP_DIR/config-$stamp.tgz"
  if tar czf "$out" -C "$H" --ignore-failed-read \
       --exclude=.claude/projects --exclude=.claude/logs --exclude=.claude/run \
       --exclude=.claude/todos --exclude=.claude/shell-snapshots \
       .claude .claude.json 2>/dev/null; then
    chmod 600 "$out"
    log "ok    config: $(basename "$out") ($(du -h "$out" | cut -f1))"
    # rotacao: mantem os N mais recentes
    ls -1t "$CFG_BACKUP_DIR"/config-*.tgz 2>/dev/null | tail -n +"$((CFG_KEEP + 1))" | xargs -r rm -f
  else
    log "WARN  config: falha ao gerar o tarball"
    return 1
  fi
}

backup_repo() {
  local dir="$1" name
  [ -d "$dir/.git" ] || return 0                       # nao e repo git -> ignora
  name=$(basename "$dir")

  # precisa de remote 'origin' p/ ter pra onde fazer push
  if ! git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    log "skip  $name: sem remote 'origin' (configure: git remote add origin <url>)"
    return 0
  fi

  # identidade local de fallback (caso a global nao exista)
  git -C "$dir" config user.email >/dev/null 2>&1 || git -C "$dir" config user.email "devbox@easypanel.local"
  git -C "$dir" config user.name  >/dev/null 2>&1 || git -C "$dir" config user.name  "claude-devbox"

  # nada mudou -> nada a fazer
  if [ -z "$(git -C "$dir" status --porcelain)" ]; then
    return 0
  fi

  # SEGURANÇA (achado F1, @security 2026-08-09): `add -A` sem exceção empurrava
  # o worklog para o GitHub sem revisão humana. O worklog é escrito pelo Stop
  # hook a partir da TRANSCRIÇÃO — e já levou uma senha root (2026-06-20) e uma
  # chave de 256 bits gerada em produção (2026-07-27) para `origin/main`.
  #
  # O hook agora redige segredo antes de escrever, mas defesa em profundidade:
  # snapshot AUTOMÁTICO (sem ninguém olhando) não leva worklog. Quem quiser
  # versionar um worklog específico o faz num commit à mão, que passa por revisão.
  git -C "$dir" add -A -- ':!docs/worklog'
  # A exclusão acima só filtra o que é estagiado AGORA — ela não desfaz o que já
  # estava no índice. Sem este reset, um worklog estagiado antes (por outra
  # ferramenta, ou por um `git add` de uma sessão) entrava no snapshot mesmo
  # assim; foi o que aconteceu no snapshot de 2026-08-09 14:41.
  git -C "$dir" reset -q -- docs/worklog 2>/dev/null || true
  # Nada sobrou para commitar depois do reset? então não cria commit vazio.
  if [ -z "$(git -C "$dir" diff --cached --name-only)" ]; then
    return 0
  fi
  git -C "$dir" commit -m "chore(backup): auto-snapshot $(date '+%F %T')" >/dev/null 2>&1
  # timeout: push numa rede travada (sem erro, sem avancar) ficaria pendurado pra sempre e
  # o loop automatico (start.sh) nunca mais chamaria backup.sh de novo (achado @qa).
  if timeout 120 git -C "$dir" push >/dev/null 2>&1; then
    log "ok    $name: snapshot enviado"
  else
    log "WARN  $name: commit local feito, push falhou (remote/credencial/branch?)"
    alert warn backup "$name" "Backup de \"$name\": commit local feito, mas o push falhou (remote/credencial/rede?)."
  fi
}

if [ "${1:-}" = "--config" ]; then
  backup_config
elif [ "$#" -ge 1 ]; then
  backup_repo "$1"
else
  [ -d "$PROJECTS_DIR" ] || { log "pasta $PROJECTS_DIR inexistente, nada a fazer"; exit 0; }
  shopt -s nullglob
  for d in "$PROJECTS_DIR"/*/; do
    [ -d "$d" ] && backup_repo "${d%/}"
  done
fi
