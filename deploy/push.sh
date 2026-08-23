#!/usr/bin/env bash
# Copies this project to your server and sets it up. Run from your Mac, in the
# project directory.
#
#   ./deploy/push.sh root@1.2.3.4          first time: copies code + runs setup
#   ./deploy/push.sh root@1.2.3.4 --code    later: code only, then restarts
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

echo "==> Copying to $TARGET:/opt/digimerchant"
ssh "$TARGET" 'mkdir -p /opt/digimerchant'
rsync -az --delete \
  --exclude node_modules --exclude data --exclude '.git' \
  --exclude '*.log' --exclude '.wwebjs_*' \
  ./ "$TARGET:/opt/digimerchant/"

if [ "$CODE_ONLY" = "--code" ]; then
  echo "==> Reinstalling dependencies and restarting"
  ssh "$TARGET" 'cd /opt/digimerchant && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund >/dev/null && chown -R digimerchant:digimerchant /opt/digimerchant && systemctl restart digimerchant && systemctl --no-pager status digimerchant | head -5'
else
  echo "==> Running setup"
  ssh "$TARGET" 'bash /opt/digimerchant/deploy/setup.sh'
fi
