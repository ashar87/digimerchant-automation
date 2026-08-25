#!/usr/bin/env bash
# Prepares a fresh Debian 12 / Ubuntu 24.04 server to run the listener.
# Idempotent — safe to re-run after a code update.
#
#   ssh root@SERVER 'bash -s' < deploy/setup.sh
#
# Assumes the code is already at /opt/digimerchant (deploy/push.sh puts it there).
set -euo pipefail

APP_DIR=/opt/digimerchant
APP_USER=digimerchant

say() { printf '\n\033[36m==>\033[0m %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }
[ -d "$APP_DIR" ] || { echo "No code at $APP_DIR — run deploy/push.sh from your Mac first."; exit 1; }

TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_MB" -lt 1800 ]; then
  echo
  echo "This box has ${TOTAL_MB}MB of RAM. Chromium needs about 2GB and will be"
  echo "OOM-killed hours in, which looks like a bug rather than a memory limit."
  echo "Resize before continuing, or set ALLOW_SMALL_RAM=1 to try anyway."
  [ "${ALLOW_SMALL_RAM:-0}" = "1" ] || exit 1
fi

if ! command -v apt-get >/dev/null; then
  echo "This script expects Debian or Ubuntu (apt). On Oracle Linux, pick an Ubuntu"
  echo "image instead — or follow 'The long version' in DEPLOY.md using dnf."
  exit 1
fi

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates chromium >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  say "Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v), chromium $(chromium --version 2>/dev/null | head -1)"

say "Setting timezone to Europe/London"
timedatectl set-timezone Europe/London

if ! swapon --show | grep -q /swapfile; then
  say "Adding 2G swap (Chromium spikes should stall, not get OOM-killed)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id -u "$APP_USER" >/dev/null 2>&1 || {
  say "Creating the $APP_USER service user"
  adduser --system --group --home "$APP_DIR" --no-create-home "$APP_USER"
}

say "Installing dependencies"
# Puppeteer has no arm64 Linux Chromium — it would fetch the x86-64 build and fail
# to launch. We use the apt one on every architecture, so never download it.
cd "$APP_DIR"
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev --no-audit --no-fund >/dev/null
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

say "Installing the systemd service"
CHROMIUM_PATH="$(command -v chromium || command -v chromium-browser)"
sed "s#^Environment=PUPPETEER_EXECUTABLE_PATH=.*#Environment=PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_PATH}#" \
  "$APP_DIR/deploy/digimerchant.service" > /etc/systemd/system/digimerchant.service
systemctl daemon-reload
systemctl enable digimerchant >/dev/null 2>&1

# Opt-in on purpose. Oracle Cloud images manage iptables directly and ship rules
# that ufw does not know about; enabling ufw there has locked people out of their
# own instances. Nothing inbound is needed for this app either way, and Oracle's
# security list already blocks inbound at the network level.
if [ "${ENABLE_UFW:-0}" = "1" ] && command -v ufw >/dev/null; then
  say "Enabling ufw (SSH only)"
  ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null
else
  say "Leaving the firewall alone (set ENABLE_UFW=1 to change that)"
fi

echo
echo "Ready. Two things left, both on the server:"
echo
echo "  1. Pair WhatsApp (scan the QR — needs your phone):"
echo "       sudo -u $APP_USER TZ=Europe/London PUPPETEER_EXECUTABLE_PATH=$CHROMIUM_PATH \\"
echo "         node $APP_DIR/scripts/list-chats.js"
echo
echo "  2. Start it:"
echo "       systemctl start digimerchant && journalctl -u digimerchant -f"
echo
