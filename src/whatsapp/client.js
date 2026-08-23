import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { log } from '../logger.js';
import { clearStaleChromeLocks } from './session.js';
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

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionPath }),
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
  client.on('disconnected', (reason) => {
    log.error('WhatsApp disconnected:', reason, '- exiting so your process manager can restart it');
    process.exit(1);
  });

  return client;
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
