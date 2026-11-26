#!/usr/bin/env bash
# Repo hygiene: every tracked file has a sane name (no quotes, pipes, spaces or control chars —
# usually the leftover of a broken shell redirect), no hosting-platform name leaks into code, and code
# comments are in English (the public repo's language; translations live only in panel/src/locales).
set -u
cd "$(dirname "$0")/.." || exit 1
fails=0; passes=0
ok() { if [ "$2" = 0 ]; then echo "  PASS $1"; passes=$((passes + 1)); else echo "  FAIL $1 ${3:-}"; fails=$((fails + 1)); fi; }
bad="$(git ls-files -z | tr '\0' '\n' | grep -vE '^[A-Za-z0-9._/@+-]+$' || true)"
ok "tracked file names are sane" "$([ -z "$bad" ] && echo 0 || echo 1)" "$bad"
leak="$(git grep -nIi 'easypanel' -- . ':!README*' ':!tests/repo-hygiene.test.sh' || true)"
ok "no hosting-platform name in code" "$([ -z "$leak" ] && echo 0 || echo 1)" "$leak"
# comments in English: a comment line with Portuguese accents or common Portuguese words fails
pt="$(git grep -nIP '(//|#|/\*|^\s*\*).*([ãõçáéíóúâêô]|\b(nao|sessao|painel|achado|tambem|entao|senao|celular|usuario|voce|aqui|pra|depois|quando)\b)' -- \
  '*.sh' '*.js' '*.mjs' '*.cjs' '*.jsx' '*.css' Dockerfile tmux.conf .env.example .dockerignore \
  ':!panel/src/locales' ':!tests/repo-hygiene.test.sh' | grep -vE "pt-BR|'pt'|Español" || true)"
ok "code comments are in English" "$([ -z "$pt" ] && echo 0 || echo 1)" "$pt"
# messages in English too: ANY line (echo/say/log/alert/ok texts, usage errors, JSON notes) of the
# shell scripts, the Dockerfile and the shipped config files. Simple heuristics: Portuguese accents
# or a short list of common Portuguese words. User-facing translations live only in the locale
# files (panel/src/locales/*.json), which are not scanned here.
ptmsg="$(git grep --untracked -nIiP '[ãõçáéíóúâêôà]|\b(nao|sessao|painel|projeto|projetos|pasta|arquivo|tentativa|binario|ausente|erro|responde|padrao|dominio|valido|recebeu|ligado|desligado|apagado|pausado|automatico|comando|segundos|usuario|voce|senha|enviado|falhou|aviso|defina|forte)\b' -- \
  '*.sh' Dockerfile docker-compose.yml .env.example panel.json managed-settings.json tmux.conf \
  ':!panel/src/locales' ':!tests/repo-hygiene.test.sh' | grep -vE 'pt-BR' || true)"
ok "shell/Dockerfile messages are in English" "$([ -z "$ptmsg" ] && echo 0 || echo 1)" "$ptmsg"
echo "$passes PASS, $fails FAIL"
[ "$fails" = 0 ]
