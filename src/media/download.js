import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { withRetry } from '../providers/retry.js';
import { downloadMediaDirect } from '../whatsapp/media.js';

fs.mkdirSync(config.mediaCachePath, { recursive: true });

const MEDIA_TYPES = ['image', 'ptt', 'audio', 'document'];

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const SHEET_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
];

/** WhatsApp message type + mime -> what we can actually do with it. */
export function classify(type, mime = '') {
  const base = String(mime).split(';')[0].trim().toLowerCase();
  if (type === 'image' && IMAGE_MIMES.includes(base)) return 'image';
  if (type === 'ptt' || type === 'audio') return 'audio';
  if (type === 'document') {
    if (base === 'application/pdf') return 'pdf';
    if (SHEET_MIMES.includes(base)) return 'sheet';
  }
  return null; // video, stickers, contacts, locations, unsupported docs
}

/** Is this attachment type switched on in .env? */
export function isEnabled(kind) {
  if (kind === 'image') return config.enableImages;
  if (kind === 'audio') return config.enableVoiceNotes;
  if (kind === 'pdf' || kind === 'sheet') return config.enableDocuments;
  return false;
}

/**
 * Downloads media off a whatsapp-web.js message. Returns null (never throws) if
 * the media is missing, too big, or a type we don't handle — a dodgy attachment
 * must not stop the rest of the conversation being processed.
 */
export async function downloadAttachment(msg, described) {
  if (!MEDIA_TYPES.includes(described.type)) return null;

  const limit = config.maxAttachmentMb * 1024 * 1024;

  // WhatsApp tells us the size before we pull the bytes down — use it when it's there.
  if (described.size && described.size > limit) {
    log.warn(`skipping ${described.type} (${(described.size / 1048576).toFixed(1)}MB > MAX_ATTACHMENT_MB=${config.maxAttachmentMb})`);
    return null;
  }

  // Cheap reject before downloading, when the mime is already known.
  if (described.mime && !isEnabled(classify(described.type, described.mime))) return null;

  let media;
  try {
    // Media often isn't resolved on the linked device the instant the message
    // arrives — the phone may still be re-uploading it. A couple of retries turns
    // most of these failures into successes.
    media = await withRetry(async () => {
      // Direct decrypt first — the library's wrapper throws on unresolved media.
      const direct = await downloadMediaDirect(msg).catch(() => null);
      if (direct?.data) return direct;
      return msg.downloadMedia();
    }, {
      attempts: 3,
      baseMs: 1500,
      always: true, // page errors carry no status or message to classify
      label: `download ${described.type}`,
    });
  } catch (err) {
    log.warn(`could not download ${described.type} from ${described.author}: ${describeError(err)}`);
    if (described.type === 'ptt' || described.type === 'audio') {
      log.warn('  a voice note was missed. Usual cause: your phone was offline or had not');
      log.warn('  re-uploaded the media yet. Linked devices cannot fetch media on their own.');
    }
    return null;
  }

  // downloadMedia resolves to undefined (rather than throwing) when WhatsApp
  // reports the media as expired, still fetching, or in an error state.
  if (!media?.data) {
    log.warn(`${described.type} from ${described.author} is not available on this device (expired or still uploading)`);
    return null;
  }

  const kind = classify(described.type, media.mimetype);
  if (!kind || !isEnabled(kind)) return null;

  const bytes = Buffer.byteLength(media.data, 'base64');
  if (bytes > limit) {
    log.warn(`skipping ${kind} (${(bytes / 1048576).toFixed(1)}MB > MAX_ATTACHMENT_MB=${config.maxAttachmentMb})`);
    return null;
  }

  return {
    kind,
    mime: String(media.mimetype).split(';')[0].trim(),
    data: media.data,
    filename: media.filename || described.filename || null,
    bytes,
  };
}

/** Writes an attachment to the media cache and returns the path (for whisper.cpp). */
export function cacheToDisk(attachment, id) {
  const ext = extensionFor(attachment.mime) || 'bin';
  const file = path.join(config.mediaCachePath, `${id.replace(/[^\w-]/g, '_')}.${ext}`);
  fs.writeFileSync(file, Buffer.from(attachment.data, 'base64'));
  return file;
}

/**
 * Errors thrown inside the browser page lose their message when they cross the
 * Puppeteer boundary, so `err.message` alone is often an empty string. Pull out
 * whatever identifying detail survived.
 */
function describeError(err) {
  const parts = [
    err?.name && err.name !== 'Error' ? err.name : null,
    err?.status ? `status ${err.status}` : null,
    err?.code || null,
    err?.message || null,
  ].filter(Boolean);

  if (parts.length) return parts.join(' · ');

  const str = String(err);
  if (str && str !== '[object Object]' && str !== 'Error') return str;

  const firstStackLine = String(err?.stack || '').split('\n')[0];
  if (firstStackLine) return firstStackLine;

  try {
    return JSON.stringify(err) || '(no detail available)';
  } catch {
    return '(no detail available)';
  }
}

function extensionFor(mime) {
  return {
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  }[mime];
}
