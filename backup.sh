#!/usr/bin/env bash
# Backup automatico dos projetos (item 6): percorre cada repo git dentro de
# $PROJ e faz add + commit (se houver mudanca) + push (best-effort). Repos sem
# remote 'origin' sao ignorados (com aviso no log). A autenticacao do push usa
# o gh/GH_TOKEN configurado no start.sh (gh auth setup-git).
#
# Uso:
#   backup.sh            -> uma passada em TODOS os projetos de $PROJ
#   backup.sh /caminho   -> backup so desse repo
#
# Roda como o usuario "ubuntu" (HOME=/root, volume). Identidade git e definida
# no start.sh (ou cai num default local aqui).
set -uo pipefail   # sem -e: um repo que falha nao aborta os demais

H=/root
PROJECT_FOLDER="${PROJECT_FOLDER:-projects}"
PROJ="$H/$PROJECT_FOLDER"
LOG_DIR="$H/.claude/logs"
LOG="$LOG_DIR/backup.log"
mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

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
  if git -C "$dir" push >/dev/null 2>&1; then
    log "ok    $name: snapshot enviado"
  else
    log "WARN  $name: commit local feito, push falhou (remote/credencial/branch?)"
  fi
}

if [ "$#" -ge 1 ]; then
  backup_repo "$1"
else
  [ -d "$PROJ" ] || { log "pasta $PROJ inexistente, nada a fazer"; exit 0; }
  shopt -s nullglob
  for d in "$PROJ"/*/; do
    [ -d "$d" ] && backup_repo "${d%/}"
  done
fi
