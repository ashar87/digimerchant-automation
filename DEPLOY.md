# Running on a server

Moves the listener off your Mac so it keeps working when the lid closes. Nothing in
the code is Mac-specific; the only fiddly parts are Chromium's dependencies and
re-pairing WhatsApp.

Budget about 30 minutes.

---

## 1. Pick a box

**2 GB RAM minimum.** This runs a real Chromium; on 1 GB it will be killed by the OOM
killer, usually hours in, and you'll think it's a bug. CPU barely matters — it idles.

| Option | Spec | Cost |
|---|---|---|
| Hetzner CAX11 (ARM) | 2 vCPU / 4 GB | ~€4/mo |
| Hetzner CX22 | 2 vCPU / 4 GB | ~€4.50/mo |
| DigitalOcean Basic | 1 vCPU / 2 GB | ~$12/mo |

ARM is fine — Chromium and Node both have arm64 builds. Use **Debian 12** or
**Ubuntu 24.04**.

Pick a region near you (Falkenstein/Nuremberg for the UK). Latency doesn't matter much,
but data residency might, given what's in these chats.

## 2. Base setup

```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y
apt install -y curl git chromium
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

timedatectl set-timezone Europe/London
```

Installing `chromium` from apt is deliberate — it pulls in the two dozen shared
libraries Puppeteer's bundled build needs but doesn't install.

Add swap, so a memory spike stalls instead of killing the process:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

A dedicated user, because this holds a live WhatsApp session:

```bash
adduser --system --group --home /opt/digimerchant digimerchant
```

## 3. Get the code onto it

The repo is private. A read-only deploy key is the least-hassle way, and makes
updates a `git pull`:

```bash
sudo -u digimerchant ssh-keygen -t ed25519 -N "" -f /opt/digimerchant/.ssh/id_ed25519
cat /opt/digimerchant/.ssh/id_ed25519.pub
```

Paste that into **GitHub → your repo → Settings → Deploy keys → Add**, leaving write
access **off**. Then:

```bash
cd /opt && rm -rf digimerchant
sudo -u digimerchant git clone git@github.com:ashar87/digimerchant-automation.git digimerchant
cd digimerchant
sudo -u digimerchant npm ci --omit=dev
```

`PUPPETEER_SKIP_DOWNLOAD=1 npm ci` skips the 150 MB Chromium download if you prefer,
since the service uses the apt one.

## 4. Move your secrets and config across

Neither file is in git — that's deliberate. From **your Mac**:

```bash
scp .env config/chats.json root@YOUR_SERVER_IP:/tmp/
```

On the server:

```bash
mv /tmp/.env /opt/digimerchant/.env
mv /tmp/chats.json /opt/digimerchant/config/chats.json
chown digimerchant:digimerchant /opt/digimerchant/.env /opt/digimerchant/config/chats.json
chmod 600 /opt/digimerchant/.env
```

Check `.env` before starting: `DRY_RUN=true` for the first day on the server.

## 5. Pair WhatsApp

The session doesn't transfer — pair fresh. The QR renders as text over SSH:

```bash
sudo -u digimerchant TZ=Europe/London PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  node /opt/digimerchant/scripts/list-chats.js
```

Scan it with **WhatsApp → Settings → Linked devices → Link a device**. Widen your
terminal if the QR looks mangled. It prints your chats and exits; the session is then
saved in `data/wa-session`.

Confirm your allowlist survived the trip:

```bash
sudo -u digimerchant node /opt/digimerchant/scripts/verify-chats.js
```

> Your Mac stays linked too — WhatsApp allows several linked devices. But **stop the
> Mac listener** before starting the server one, or both will process the same
> messages and you'll get every task card twice.

## 6. Run it as a service

```bash
cp /opt/digimerchant/deploy/digimerchant.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now digimerchant
systemctl status digimerchant
```

The unit uses `KillSignal=SIGINT` on purpose: the app flushes buffered conversations
and closes Chromium cleanly on SIGINT, and a hard-killed Chromium leaves a profile
lock that costs you a fresh QR scan.

`Restart=always` is the reconnect strategy — the app exits deliberately when WhatsApp
disconnects, and systemd brings it straight back.

## 7. Logs

```bash
journalctl -u digimerchant -f              # live
journalctl -u digimerchant --since today   # today
journalctl -u digimerchant --since today > /tmp/dry.log
node /opt/digimerchant/scripts/report.js /tmp/dry.log
```

`npm run report` works the same on a journald export as on a `dryrun.log`.

## 8. Go live

Once a day of dry-run output looks right:

```bash
sudo -u digimerchant node /opt/digimerchant/scripts/reset-queue.js
sed -i 's/^DRY_RUN=true/DRY_RUN=false/' /opt/digimerchant/.env
systemctl restart digimerchant
```

## Updating later

```bash
cd /opt/digimerchant
sudo -u digimerchant git pull
sudo -u digimerchant npm ci --omit=dev
systemctl restart digimerchant
```

---

## What this server holds

Worth being clear-eyed, because it's more sensitive than most side projects:

- **A live WhatsApp session token.** Anyone with root can read your messages as you.
  Use SSH keys only, disable password login, and don't share access.
- **Your Gemini and Notion API keys**, in `/opt/digimerchant/.env` (chmod 600).
- **Cached voice-note transcripts and message IDs** in `data/`.

No inbound ports are needed — it only makes outbound connections. Keep the firewall
closed to everything except SSH:

```bash
ufw allow OpenSSH && ufw --force enable
```

If the box is ever compromised, unlink it from **WhatsApp → Linked devices** first,
then rotate the Gemini and Notion keys.

## When it breaks after a WhatsApp update

See the drift table in [README.md](README.md#a-note-on-whatsapp-webjs-drift). Start with:

```bash
sudo -u digimerchant node /opt/digimerchant/scripts/diagnose-media.js
```
