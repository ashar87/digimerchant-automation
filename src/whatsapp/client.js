import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config } from '../config.js';
import { log } from '../logger.js';

const { Client, LocalAuth } = pkg;

/**
 * Wraps whatsapp-web.js. This attaches to your normal WhatsApp account the same
 * way WhatsApp Web does — your phone stays the source of truth, and the session
 * is cached in data/wa-session so you only scan the QR code once.
 */
export function createWhatsAppClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', (qr) => {
    console.log('\nScan this with WhatsApp → Settings → Linked devices → Link a device:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => log.ok('WhatsApp authenticated — session saved, no QR needed next time'));
  client.on('auth_failure', (m) => log.error('WhatsApp auth failed:', m));
  client.on('disconnected', (reason) => {
    log.error('WhatsApp disconnected:', reason, '- exiting so your process manager can restart it');
    process.exit(1);
  });

  return client;
}

/** Everything we need from a raw whatsapp-web.js message, in a plain shape. */
export async function describeMessage(msg) {
  const chat = await msg.getChat();
  const contact = await msg.getContact();
  return {
    id: msg.id._serialized,
    chatId: chat.id._serialized,
    chatName: chat.name,
    isGroup: chat.isGroup,
    fromMe: msg.fromMe,
    author: msg.fromMe ? 'Ashar' : contact.pushname || contact.name || contact.number || 'Unknown',
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
