#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "9.9.9 (Claude Code)"; exit 0; }
PICKS="$HOME/.fake-claude-picks"
# like the real one: the config dir (credentials, .claude.json) is CLAUDE_CONFIG_DIR when set, else ~/.claude
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
cls() { printf '\033[H\033[2J'; }
key() { local k k2; IFS= read -rsn1 k; if [ "$k" = $'\e' ]; then IFS= read -rsn2 -t 0.2 k2; k="ESC$k2"; fi; KEY="$k"; }
wait_enter() { while :; do key; [ -z "$KEY" ] && return; done; }
# menu <id> <title> <options...>; initial cursor at $CUR; "No, exit" closes claude (like the real one)
menu() {
  local id="$1" title="$2"; shift 2; local opts=("$@") cur="${CUR:-0}" i
  while :; do
    cls; printf '%b\n' "$title"
    for i in "${!opts[@]}"; do if [ "$i" = "$cur" ]; then echo " ❯ ${opts[$i]}"; else echo "   ${opts[$i]}"; fi; done
    echo " Enter to confirm · Esc to cancel"
    key
    case "$KEY" in
      "ESC[A") [ "$cur" -gt 0 ] && cur=$((cur - 1)) ;;
      "ESC[B") [ "$cur" -lt $((${#opts[@]} - 1)) ] && cur=$((cur + 1)) ;;
      "") echo "$id=${opts[$cur]}" >> "$PICKS"; [ "${opts[$cur]}" = "No, exit" ] && exit 0; return ;;
    esac
  done
}
do_login() {
  CUR=1 menu method "Claude Code can be used with your Claude subscription or billed based on API usage.\n Select login method:" \
    "1. Claude account with subscription · Individual, Team, or Enterprise" "2. Anthropic Console account · API usage billing" "3. 3rd-party platform · Bedrock, Microsoft Foundry, Google Vertex AI"
  case "$(tail -n1 "$PICKS")" in *"Claude account with subscription"*) ;; *) echo "wrong login method"; exit 1 ;; esac
  while :; do
    cls; echo " Browser didn't open? Use the URL below to sign in (c to copy)"
    echo "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=__LONG__"
    printf " Paste code here if prompted > "; read -r code
    LAST_CODE="$code"; [ "$code" = "good-code" ] && break
    echo " OAuth error: Invalid code"; sleep 600; exit 1
  done
  mkdir -p "$CFG"; echo '{"ok":1}' > "$CFG/.credentials.json"
  cls; echo " Login successful. Press Enter to continue"; wait_enter; echo "login-success cfg=$CFG" >> "$PICKS"
}
repl() {
  while :; do
    cls; echo " ▐▛███▜▌   Claude Code v9.9.9"; echo "────────"; echo "❯ "; echo "────────"
    echo "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
    read -r line; [ "$line" = "/login" ] && { echo "repl=/login" >> "$PICKS"; do_login; }
  done
}
if [ -s "$CFG/.credentials.json" ]; then repl; fi
CUR=0 menu theme " Let's get started.\n Choose the text style that looks best with your terminal\n To change this later, run /theme" \
  "✔ Auto (match terminal)" "Dark mode" "Light mode"
do_login
cls; printf ' Security notes:\n 1. Claude can make mistakes.\n 2. Due to prompt injection risks, only use it with code you trust\n    Learn more: https://code.claude.com/docs/en/security\n Press Enter to continue\n'; wait_enter; echo "security-notes" >> "$PICKS"
CUR=0 menu terminal " Use Claude Code's terminal setup?\n For the optimal coding experience, enable the recommended settings for your terminal" \
  "1. Yes, use recommended settings" "2. No, maybe later with /terminal-setup"
CUR=0 menu trust " Accessing workspace:\n $PWD\n Quick safety check: Is this a project you created or one you trust?" "No, exit" "Yes, I trust this folder"
CUR=0 menu bypass "  WARNING: Claude Code running in Bypass Permissions mode\n  By proceeding, you accept all responsibility" "No, exit" "Yes, I accept"
cls; printf " What's new in 9.9.9\n  • a brand-new screen the panel does not know yet\n  (tap the big button)\n  last input: %s\n" "$LAST_CODE"; wait_enter; echo "unknown-passed" >> "$PICKS"
repl
