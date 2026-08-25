# Running on a server

Moves the listener off your Mac so it keeps working when the lid closes. Nothing in
the code is Mac-specific; the only fiddly parts are Chromium's dependencies and
re-pairing WhatsApp.

Budget about 30 minutes.

---

## The short version

Two commands from your Mac, then scan a QR code.

**1. Create a server.** Debian 12 or Ubuntu 24.04, **2 GB RAM minimum** (this runs a real
Chromium; 1 GB gets OOM-killed hours in and looks like a bug). Add your SSH key when
creating it. See [Where to host](#where-to-host) for options — any plain VM works.

**2. Push and set up:**

```bash
./deploy/push.sh root@YOUR_SERVER_IP
```

That copies the code plus your `.env` and `config/chats.json` (both gitignored, so this is
how they get there), installs Node, Chromium and swap, creates a service user, installs the
systemd unit, and closes the firewall to everything but SSH. It's idempotent — re-run it
any time.

**3. Pair WhatsApp and start.** The script prints both commands when it finishes. Pairing
shows a QR in your terminal; scan it with **WhatsApp → Settings → Linked devices**.

**4. Deploying changes later:**

```bash
./deploy/push.sh root@YOUR_SERVER_IP --code
```

> **Stop the Mac listener before starting the server one.** WhatsApp allows several linked
> devices, so both will happily process the same messages and send you every task card twice.

Logs:

```bash
ssh root@YOUR_SERVER_IP 'journalctl -u digimerchant -f'
```

Going live once the dry run looks right:

```bash
ssh root@YOUR_SERVER_IP 'sudo -u digimerchant node /opt/digimerchant/scripts/reset-queue.js   && sed -i "s/^DRY_RUN=true/DRY_RUN=false/" /opt/digimerchant/.env   && systemctl restart digimerchant'
```

---

## Where to host

The requirements are narrow: a **plain Linux VM**, **2 GB RAM**, a **persistent disk**, and
the ability to run a long-lived process. Any of these work with `deploy/push.sh` unchanged.

| Host | 2 GB plan | Region | Notes |
|---|---|---|---|
| **Hetzner** CX22 | ~€4.49 | DE, FI | Cheapest credible option. Set the location to **Germany or Finland** — US and Singapore cost more, and the ARM shapes aren't offered there. |
| **Hetzner** CAX11 (ARM) | ~€5.99 | DE, FI | ARM; the scripts handle it. |
| **OVHcloud** VPS | ~£5 | UK, FR | Has a **UK** datacentre if you'd rather keep data in the UK. |
| **DigitalOcean** | ~$12 | London | Priciest of these, but the least friction — good docs, clean console. |
| **Vultr** | ~$10 | London | Similar to DO, slightly cheaper. |
| **Linode / Akamai** | ~$12 | London | Long-established, solid. |
| **AWS Lightsail** | ~$10 | London | Worth it only if you already live in AWS. |
| **Oracle Cloud Free Tier** | **£0** | UK, DE | 4 ARM cores / 24 GB genuinely free forever. See the caveat below. |

> **Avoid Hetzner's CPX line.** CPX22 went from €7.99 to €19.49/mo in a June 2026
> price change. The CX and CAX lines are unaffected and are what you want here — the
> extra CPU in a CPX buys nothing for a workload that idles.
>
> Cloud pricing moves. Treat every figure in this table as "check the console", not gospel.

### Oracle's free tier

Real, and generously sized. Two honest caveats: ARM capacity is frequently unavailable in
popular regions and you may have to retry for days, and Oracle has been known to reclaim
idle free-tier instances. For something you want running unattended for months, that's a
meaningful risk against saving £4/month. Fine if you enjoy the tinkering; not what I'd
rely on.

**If you do use Oracle, four things differ from a normal VPS:**

1. **Pick the right shape.** `VM.Standard.A1.Flex` (Ampere ARM) — give it at least
   2 OCPUs and 6 GB, all within the free allowance. The other always-free shape,
   `VM.Standard.E2.1.Micro`, has **1 GB and will not work**; Chromium is OOM-killed.
2. **Choose the Ubuntu image**, not Oracle Linux. `setup.sh` uses apt.
3. **You log in as `ubuntu`, not `root`.** Oracle disables root SSH. `push.sh` handles
   this — just use `ubuntu@YOUR_IP`.
4. **Do not enable ufw.** Oracle's images manage iptables directly with rules ufw doesn't
   know about, and enabling it has locked people out of their own instances. `setup.sh`
   leaves the firewall alone unless you pass `ENABLE_UFW=1`. You don't need it here:
   nothing inbound is required, and Oracle's security list already blocks inbound at the
   network level.

ARM is fine — the scripts skip Puppeteer's x86-only Chromium download and use the apt one.

### A Windows laptop

Three routes, best first.

**1. Wipe it and install Ubuntu Server.** If the laptop is genuinely spare, this is the
cleanest answer by a distance: `deploy/setup.sh` runs unchanged, you get systemd, and
everything in this document applies as written. Ubuntu Server 24.04, no desktop, SSH
enabled. Then:

```bash
./deploy/push.sh youruser@LAPTOP_IP
```

**2. Keep Windows, run it in WSL2.** Works well, with one wrinkle — WSL doesn't start on
its own at boot.

```powershell
wsl --install -d Ubuntu-24.04
```

Inside Ubuntu, turn on systemd (needed for the service):

```bash
printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
```

Then `wsl --shutdown` in PowerShell and reopen. From there, `deploy/setup.sh` works
normally. To start it at boot, create a Task Scheduler task that runs at logon:

```
Program:   wsl.exe
Arguments: -d Ubuntu-24.04 -u root /bin/true
```

That boots the distro; systemd then starts the service on its own.

**3. Native Windows, no WSL.** The app itself is plain Node and will run — but there is no
systemd, so `deploy/` doesn't apply and you'd manage the process with NSSM or Task
Scheduler yourself. Voice-note fallback also needs a Windows `ffmpeg` on PATH. Workable,
but you're maintaining it by hand. Only worth it if WSL is unavailable to you.

### Stopping Windows from sleeping

This is the part that actually decides whether it works. A sleeping laptop catches
nothing, and there is no backlog to recover afterwards.

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
```

Then **Control Panel → Power Options → Choose what closing the lid does → When plugged in:
Do nothing**, so you can shut the lid and leave it somewhere out of the way. Keep it on
mains — on battery, Windows will sleep regardless of these settings.

Set `CATCH_UP_MINUTES=60` in `.env` so a restart sweeps the last hour.

### A spare laptop or mini PC

If you have an old laptop gathering dust, it beats a Raspberry Pi for this: x86 so no ARM
Chromium issues, a real SSD instead of an SD card, and **a battery, which is a built-in
UPS**. Install Ubuntu Server, set `HandleLidSwitch=ignore` in `/etc/systemd/logind.conf`
so closing the lid doesn't suspend it, and run `deploy/setup.sh` exactly as written.

Same trade as the Pi, though: your power and broadband, and a power cut loses messages
outright because linked devices receive no backlog.

### What does not work

- **Anything under 2 GB.** Chromium gets OOM-killed hours in, looking like a bug.
- **Vercel, Lambda, Cloud Run and similar.** A WhatsApp Web session needs a long-lived
  process and a persistent disk; serverless gives you neither.
- **Container platforms with ephemeral disks** (default Railway, Render free). The session
  in `data/` must survive restarts or you re-scan the QR every deploy. Workable only with
  a real persistent volume attached.

### Does jurisdiction matter here?

Only a little, and worth being clear about it. The chat content is sent to **Google** for
extraction regardless of where this runs, so hosting in the UK doesn't keep the messages
in the UK. What the server holds is the WhatsApp session token, cached transcripts and
message ids. If that distinction matters to you, pick a UK region (OVH, DigitalOcean,
Vultr, Linode); otherwise Hetzner's EU datacentres are fine under GDPR.

---

## The long version

What `setup.sh` does, if you'd rather run it by hand or need to debug it.

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

On **ARM** (Hetzner CAX, Raspberry Pi, Ampere) this is not optional:

```bash
sudo -u digimerchant PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev
```

Puppeteer publishes no arm64 Linux Chromium. Left to itself it downloads the **x86-64**
build, the install succeeds, and the browser then fails to launch with an opaque error
that looks like a bug in this project. The app now detects ARM without
`PUPPETEER_EXECUTABLE_PATH` and says so on startup, but skipping the download avoids
the wasted 150 MB.

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

## Running it on a Raspberry Pi instead

A good fit for this project, and arguably better than a VPS on the thing that matters
most here: **your WhatsApp session and your business chats never leave your house.**
Given these chats carry supplier pricing, margins and market research, that is a real
advantage over trusting a rented box.

The trade is reliability. A VPS has redundant power and network; a Pi has your
electricity supply and your broadband.

### Which Pi

| Model | Verdict |
|---|---|
| Pi 5 (4 GB or 8 GB) | Best. Comfortable headroom, NVMe via HAT. |
| Pi 4 (4 GB or 8 GB) | Fine. This workload is mostly idle. |
| Pi 4 (2 GB) | Tight but workable if nothing else runs on it. |
| Pi Zero 2 W, Pi 3, any 1 GB model | **No.** Chromium will be OOM-killed. |

Use **64-bit Raspberry Pi OS Lite** — headless, no desktop. A 32-bit OS will fight you
on both Node and Chromium.

### If you're buying a Pi 4 (bare board)

A board on its own won't run. You also need:

| Part | Why it matters |
|---|---|
| **Official USB-C PSU** (5.1V / 3A) | Not a phone charger. Under-voltage on a Pi 4 causes random crashes and filesystem corruption that look exactly like software bugs. This is the most common cause of "my Pi is unreliable". |
| **USB3 SSD + enclosure** | See below. A Pi 4 has no NVMe slot, so USB3 is the route. 120 GB is plenty. |
| **Case with active or heatsink cooling** | A Pi 4 throttles under sustained load and runs hot 24/7. A passive heatsink case is the minimum; a quiet fan case is better. |

A starter kit bundling PSU, case and heatsinks is often cheaper than buying them
separately — but check whether its storage is a microSD, and plan to ignore it if so.

You do **not** need a micro-HDMI cable, keyboard or monitor. Flash the SD/SSD with
Raspberry Pi Imager, enable SSH and your Wi-Fi/Ethernet in its settings screen before
writing, and drive the whole thing over SSH.

Two Pi 4 specifics:

- **USB boot** is enabled by default on Pi 4s made since around 2020. On an older
  board, boot once from microSD and run `sudo raspi-config` → Advanced → Bootloader
  Version → Latest, then move to the SSD.
- **Some USB3 SSD enclosures** (certain JMicron and ASMedia chipsets) misbehave on a Pi 4
  under UAS and need a `usb-storage.quirks` line in `/boot/cmdline.txt`. If the Pi hangs
  or drops the disk under load, that's the cause — search the enclosure's chipset ID
  plus "Pi 4 quirks".

### Boot from an SSD, not a microSD card

The single most important choice. This writes continuously — SQLite in WAL mode, the
Chromium profile, journald — and a microSD will wear out and then corrupt, usually
months in and always without warning. Worse, a power cut mid-write can corrupt the card
outright and cost you the WhatsApp session.

Use a USB3 SSD, or an NVMe HAT on a Pi 5. If you must use a microSD, add `log2ram` to
keep journald out of it, and take a copy of `data/wa-session` somewhere safe.

Use the **official power supply**. Under-voltage on a Pi shows up as random crashes
that look like software faults.

### Setup differences

Everything above applies, with three changes:

```bash
sudo apt install -y chromium-browser        # the package is named differently on Pi OS
which chromium-browser || which chromium    # confirm the path
```

Then in the systemd unit, point at what `which` reported:

```ini
Environment=PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

And install with the ARM flag:

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --omit=dev
```

Paths differ too — use `/home/pi/digimerchant` and your own user rather than creating a
`digimerchant` system user, unless you want the separation.

### What you don't need

**No port forwarding, and no static IP.** The app only makes outbound connections — it
never accepts one. Nothing about this needs to be reachable from the internet, which
removes the usual reason self-hosting is risky.

### Power cuts

The app exits when WhatsApp disconnects and systemd restarts it, so a brief network drop
self-heals. A power cut is different: messages that arrive while the Pi is off are gone,
because linked devices get no backlog. `CATCH_UP_MINUTES` in `.env` recovers a short
window after a restart — raise it to `60` on a Pi if your power is unreliable.

A small UPS is worth it if you get cuts, mostly to protect the filesystem rather than
uptime.

### Pi or VPS?

- **Pi** if you already have one, or if keeping the WhatsApp session and chat content in
  your own house matters to you. It does cost more up front (~£60–100) but nothing
  monthly, so it pays back against a £4/month VPS in about eighteen months.
- **VPS** if uninterrupted capture matters more than data residency, or if you would
  rather not have another device to look after.

Either way the code, the systemd unit and the logging are identical.

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
