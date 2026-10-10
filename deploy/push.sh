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
# GitHub and this is how they reach the server. .env is merged, not replaced: a
# key set only on the server (a secret put there with set-secret.sh) is kept.
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: ./deploy/push.sh user@host [--code]"; exit 1; }
CODE_ONLY="${2:-}"

command -v rsync >/dev/null || { echo "rsync not found locally"; exit 1; }

# -t only when we have a terminal, so sudo can prompt interactively without
# ssh complaining when this runs non-interactively.
SSH_T=$([ -t 0 ] && echo "-t" || echo "-T")
[ -f .env ] || { echo "No .env here — run this from the project directory."; exit 1; }
[ -f config/chats.json ] || { echo "No config/chats.json — run 'npm run chats' first."; exit 1; }

# Root logs in as root; everyone else needs sudo for /opt and systemd.
SUDO='$(if [ "$(id -u)" -eq 0 ]; then echo ""; else echo "sudo"; fi)'

echo "==> Preparing /opt/digimerchant on $TARGET"
# Debian's minimal cloud images ship without rsync, so make sure it is there
# before we try to use it as a transport.
ssh $SSH_T "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
  command -v rsync >/dev/null || { echo '==> Installing rsync on the server'; \
    \$SUDO apt-get update -qq && \$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync >/dev/null; }"

# Owned by the login user during the copy, handed to the service user by setup.sh.
ssh $SSH_T "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
  \$SUDO mkdir -p /opt/digimerchant && \$SUDO chown -R \$(id -un):\$(id -gn) /opt/digimerchant"

echo "==> Copying code, .env and config/chats.json"
rsync -az --delete \
  --exclude node_modules --exclude data --exclude '.git' \
  --exclude '*.log' --exclude '.wwebjs_*' --exclude private --exclude .claude --exclude .env \
  ./ "$TARGET:/opt/digimerchant/"

echo "==> Merging .env (keys set only on the server are kept)"
ssh -T "$TARGET" 'umask 077 && cat > "$HOME/.env.push"' < .env
ssh $SSH_T "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
  \$SUDO sh -c 'umask 077; f=/opt/digimerchant/.env; touch \"\$f\"; awk -f /opt/digimerchant/deploy/env-merge.awk \"\$f\" \"\$0\" > \"\$f.new\" && mv \"\$f.new\" \"\$f\" && { chown digimerchant:digimerchant \"\$f\" 2>/dev/null || true; }' \"\$HOME/.env.push\"; \
  rc=\$?; rm -f \"\$HOME/.env.push\"; exit \$rc"

if [ "$CODE_ONLY" = "--code" ]; then
  echo "==> Reinstalling dependencies and restarting"
  ssh $SSH_T "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
    cd /opt/digimerchant && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund >/dev/null && \
    \$SUDO chown -R digimerchant:digimerchant /opt/digimerchant && \
    \$SUDO systemctl restart digimerchant && \
    \$SUDO systemctl --no-pager status digimerchant | head -5"
else
  echo "==> Running setup (sudo on the server)"
  ssh $SSH_T "$TARGET" "SUDO=\$(if [ \$(id -u) -eq 0 ]; then echo ''; else echo sudo; fi); \
    \$SUDO bash /opt/digimerchant/deploy/setup.sh"
fi
