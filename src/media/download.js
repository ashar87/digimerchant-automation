import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../logger.js';
import { downloadMediaDirect, pageStuck } from '../whatsapp/media.js';

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
    if (IMAGE_MIMES.includes(base)) return 'image'; // a photo sent as a file
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
// About a minute in all: 2s, 4s, 8s, 15s, 30s between attempts.
const DOWNLOAD_WAITS_MS = [2000, 4000, 8000, 15000, 30000];
const DOWNLOAD_ATTEMPTS = DOWNLOAD_WAITS_MS.length + 1;

/** `force`: download images and documents even when switched off in .env (the supplier group's files). */
export async function downloadAttachment(msg, described, { force = false } = {}) {
  const allowed = (kind) => (force ? kind === 'image' || kind === 'pdf' || kind === 'sheet' : isEnabled(kind));
  if (!MEDIA_TYPES.includes(described.type)) return null;

  const limit = config.maxAttachmentMb * 1024 * 1024;

  // WhatsApp tells us the size before we pull the bytes down — use it when it's there.
  if (described.size && described.size > limit) {
    log.warn(`skipping ${described.type} (${(described.size / 1048576).toFixed(1)}MB > MAX_ATTACHMENT_MB=${config.maxAttachmentMb})`);
    return null;
  }

  // Cheap reject before downloading, when the mime is already known.
  if (described.mime && !allowed(classify(described.type, described.mime))) return null;

  // Media often isn't ready on the linked device the instant a message arrives:
  // the sender's phone may still be uploading it, or WhatsApp hasn't resolved it.
  // So keep trying for about a minute, and log WHY each attempt failed. There's
  // no fallback to the library's own download: its message lookup is what's
  // broken on current WhatsApp Web (see src/whatsapp/media.js).
  let media;
  let last = null;
  let stuck = 0;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const r = await downloadMediaDirect(msg);
    if (r?.data) {
      media = r;
      if (attempt > 1) log.info(`downloaded ${described.type} from ${described.author} on attempt ${attempt}`);
      break;
    }
    last = r;
    // Twice stuck means WhatsApp Web itself is wedged: waiting longer won't help;
    // the caller records it so it's retried after the listener reconnects.
    if (pageStuck(r) && ++stuck >= 2) break;
    if (attempt < DOWNLOAD_ATTEMPTS) {
      const wait = DOWNLOAD_WAITS_MS[attempt - 1];
      log.warn(`download ${described.type}: ${r?.reason} (${r?.detail}) — retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${DOWNLOAD_ATTEMPTS})`);
      await new Promise((res) => setTimeout(res, wait));
    }
  }
  if (!media) {
    described.downloadFailure = last;
    described.downloadStuck = pageStuck(last);
    log.warn(`could not download ${described.type} from ${described.author}: ${last?.reason} (${last?.detail})`);
    if (described.type === 'ptt' || described.type === 'audio') {
      log.warn('  a voice note was missed. If the reason is not-ready or no-media-path, the sender’s phone');
      log.warn('  probably hadn’t finished uploading it; anything else is worth reporting.');
    }
    return null;
  }

  const kind = classify(described.type, media.mimetype);
  if (!kind || !allowed(kind)) return null;

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
