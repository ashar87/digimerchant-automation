import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { log } from '../logger.js';
import { clearStaleChromeLocks, clearWebAppCache } from './session.js';
import { messageKey, widString } from './ids.js';

const { Client, LocalAuth } = pkg;

/**
 * Wraps whatsapp-web.js. This attaches to your normal WhatsApp account the same
 * way WhatsApp Web does — your phone stays the source of truth, and the session
 * is cached in data/wa-session so you only scan the QR code once.
 */
export function createWhatsAppClient() {
  // A previous run killed mid-flight would otherwise cost you a fresh QR scan.
  clearStaleChromeLocks(config.sessionPath);
  warnIfArmWithoutSystemChromium();

  if (config.waWebVersion) {
    // Otherwise the copy WhatsApp Web downloaded of its newest build overrides the pin.
    const cleared = clearWebAppCache(config.sessionPath);
    log.info(`WhatsApp Web pinned to ${config.waWebVersion}${cleared.length ? ` (cleared its cached app: ${cleared.join(', ')})` : ''}`);
  }
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionPath }),
    // strict: a missing page file stops the start loudly instead of quietly using the live version.
    ...(config.waWebVersion ? { webVersion: config.waWebVersion, webVersionCache: { type: 'local', path: config.waWebCachePath, strict: true } } : {}),
    puppeteer: {
      headless: true,
      // On a server, install the distro's chromium and point at it — apt pulls in
      // the shared libraries Puppeteer's bundled build would otherwise need.
      ...(process.env.PUPPETEER_EXECUTABLE_PATH
        ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
        : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // /dev/shm is tiny on most VPSs; Chromium crashes without this
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', (qr) => {
    console.log('\nScan this with WhatsApp → Settings → Linked devices → Link a device:\n');
    qrcode.generate(qr, { small: true });
  });

  // whatsapp-web.js emits `authenticated` several times while the page settles.
  let announced = false;
  client.on('authenticated', () => {
    if (announced) return;
    announced = true;
    log.ok('WhatsApp authenticated — session saved, no QR needed next time');
  });

  client.on('auth_failure', (m) => log.error('WhatsApp auth failed:', m));
  // Progress while WhatsApp Web loads, so a start that stalls shows where.
  client.on('loading_screen', (percent, message) => log.info(`WhatsApp loading ${percent}% ${message || ''}`.trim()));
  client.on('change_state', (state) => log.info(`WhatsApp state: ${state}`));
  client.on('disconnected', (reason) => {
    log.error('WhatsApp disconnected:', reason, '- exiting so your process manager can restart it');
    process.exit(1);
  });

  return client;
}

/**
 * On ARM Linux (Raspberry Pi, Hetzner CAX, Ampere) Puppeteer resolves its Chromium
 * download to the linux64 x86-64 build — it does not publish an arm64 Linux build.
 * The install succeeds and the launch then fails with an opaque error. Say so up
 * front instead of letting it look like a bug in this project.
 */
function warnIfArmWithoutSystemChromium() {
  const isArmLinux = process.platform === 'linux' && process.arch === 'arm64';
  if (!isArmLinux || process.env.PUPPETEER_EXECUTABLE_PATH) return;

  log.error('ARM Linux detected with no PUPPETEER_EXECUTABLE_PATH set.');
  log.error("Puppeteer has no arm64 Linux Chromium — it downloads the x86-64 build, which cannot run here.");
  log.error('Fix:  sudo apt install -y chromium   (or chromium-browser on Raspberry Pi OS)');
  log.error('Then: export PUPPETEER_EXECUTABLE_PATH=$(which chromium || which chromium-browser)');
  log.error('See DEPLOY.md. Continuing, but the browser will probably fail to launch.');
}

/**
 * Everything we need from a raw whatsapp-web.js message, in a plain shape.
 *
 * Deliberately avoids msg.getChat(): that hydrates the chat through WhatsApp Web's
 * internal serialiser, which breaks whenever WhatsApp changes its internals and
 * takes the whole message down with it. The chat JID is already on the message.
 */
export async function describeMessage(msg) {
  const chatId = widString(msg.id?.remote) || widString(msg.fromMe ? msg.to : msg.from);
  const isGroup = String(chatId).endsWith('@g.us');

  return {
    id: messageKey(msg.id),
    chatId,
    isGroup,
    fromMe: msg.fromMe,
    author: msg.fromMe ? 'Ashar' : await senderName(msg),
    body: (msg.body || '').trim(),
    timestamp: msg.timestamp,
    type: msg.type,
    hasMedia: msg.hasMedia,
    mime: (msg._data?.mimetype || '').split(';')[0].trim() || null,
    filename: msg._data?.filename || null,
    size: msg._data?.size || null,
    hasQuotedMsg: msg.hasQuotedMsg,
  };
}

/**
 * WhatsApp already sends the sender's display name with the message, so the
 * common case needs no lookup. Only fall back to the contact store if it's absent.
 */
async function senderName(msg) {
  const notified = msg._data?.notifyName;
  if (notified) return String(notified).trim();

  try {
    const contact = await msg.getContact();
    return contact.pushname || contact.name || contact.number || 'Unknown';
  } catch {
    const jid = msg.author || msg.from || '';
    return String(jid).split('@')[0] || 'Unknown';
  }
}
