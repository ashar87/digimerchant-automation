#!/usr/bin/env bash
# Copies this project to your server and sets it up. Run from your Mac, in the
# project directory.
#
#   ./deploy/push.sh ubuntu@1.2.3.4          first time: copies code + runs setup
#   ./deploy/push.sh ubuntu@1.2.3.4 --code    later: code only, then restarts
#
# Works as root or as a sudo user. Oracle Cloud, AWS and GCP all disable root SSH
# and give you 'ubuntu' or 'opc' instead.
#
# Sends .env and config/chats.json too — they are gitignored, so they are not on
# GitHub and this is how they reach the server.
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: ./deploy/push.sh user@host [--code]"; exit 1; }
CODE_ONLY="${2:-}"

command -v rsync >/dev/null || { echo "rsync not found"; exit 1; }
[ -f .env ] || { echo "No .env here — run this from the project directory."; exit 1; }
[ -f config/chats.json ] || { echo "No config/chats.json — run 'npm run chats' first."; exit 1; }

# Root logs in as root; everyone else needs sudo for /opt and systemd.
SUDO='$(if [ "$(id -u)" -eq 0 ]; then echo ""; else echo "sudo"; fi)'

echo "==> Preparing /opt/digimerchant on $TARGET"
# Owned by the login user during the copy, handed to the service user by setup.sh.
ssh "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
  \$SUDO mkdir -p /opt/digimerchant && \$SUDO chown -R \$(id -un):\$(id -gn) /opt/digimerchant"

echo "==> Copying code, .env and config/chats.json"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude '.git' \
  --exclude '*.log' --exclude '.wwebjs_*' \
  ./ "$TARGET:/opt/digimerchant/"

if [ "$CODE_ONLY" = "--code" ]; then
  echo "==> Reinstalling dependencies and restarting"
  ssh "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
    cd /opt/digimerchant && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund >/dev/null && \
    \$SUDO chown -R digimerchant:digimerchant /opt/digimerchant && \
    \$SUDO systemctl restart digimerchant && \
    \$SUDO systemctl --no-pager status digimerchant | head -5"
else
  echo "==> Running setup (sudo on the server)"
  ssh -t "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
    \$SUDO bash /opt/digimerchant/deploy/setup.sh"
fi
