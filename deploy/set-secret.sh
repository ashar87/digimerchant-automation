#!/usr/bin/env bash
# Puts one secret into the server's .env without it passing through a chat, the
# command line, or your shell history: you paste it at a hidden prompt.
#
#   ./deploy/set-secret.sh debian@YOUR_SERVER_IP SPAPI_REFRESH_TOKEN_EU
#
# Then restart whatever reads it (e.g. sudo systemctl restart digimerchant-dashboard).
set -euo pipefail

TARGET="${1:-}"
KEY="${2:-}"
[ -n "$TARGET" ] && [ -n "$KEY" ] || { echo "usage: ./deploy/set-secret.sh user@host NAME"; exit 1; }
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "Name must look like SPAPI_REFRESH_TOKEN_EU"; exit 1; }

# Overridable only so the quoting can be tested locally.
SSH="${SET_SECRET_SSH:-ssh}"
ENV_FILE="${SET_SECRET_ENV_FILE:-/opt/digimerchant/.env}"
OWNER="${SET_SECRET_OWNER:-digimerchant:digimerchant}"
SSH_T=$([ -t 0 ] && echo "-t" || echo "-T")

if [ -n "${SET_SECRET_VALUE:-}" ]; then VALUE="$SET_SECRET_VALUE"; else
  read -rsp "Paste $KEY (input hidden): " VALUE
  echo
fi
[ -n "$VALUE" ] || { echo "Nothing pasted; nothing changed."; exit 1; }
case "$VALUE" in *$'\n'*) echo "The value has a line break in it; check what you copied."; exit 1;; esac

# 1. The value travels over SSH on stdin into a private temp file (never in argv).
printf '%s' "$VALUE" | $SSH -T "$TARGET" "umask 077 && cat > \"\$HOME/.secret-$KEY\""
unset VALUE

# 2. sudo (which may prompt for your password) moves it into .env, replacing any old line.
$SSH $SSH_T "$TARGET" "S=\"\$HOME/.secret-$KEY\"; \
  SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
  \$SUDO sh -c 'f=\"\$3\"; touch \"\$f\"; { grep -v \"^\$1=\" \"\$f\" || true; printf \"%s=%s\\n\" \"\$1\" \"\$(cat \"\$2\")\"; } > \"\$f.new\" && mv \"\$f.new\" \"\$f\" && chmod 600 \"\$f\" && { chown \"\$4\" \"\$f\" 2>/dev/null || true; }' _ $KEY \"\$S\" '$ENV_FILE' '$OWNER'; \
  rc=\$?; rm -f \"\$S\"; exit \$rc"

echo "$KEY set on $TARGET."
