import { log } from '../logger.js';
import { downloadAttachment } from './download.js';
import { transcribe } from './transcribe.js';
import { sheetToText } from './documents.js';

/**
 * Turns a raw WhatsApp message into the shape the conversation buffer wants.
 * Voice notes become text, spreadsheets become text, images and PDFs ride along
 * as binary attachments. Returns null for anything with nothing usable in it.
 */
export async function toBufferMessage(msg, m) {
  const base = { author: m.author, timestamp: m.timestamp, attachments: [], isVoiceNote: false };

  if (!m.hasMedia) {
    return m.body ? { ...base, body: m.body } : null;
  }

  const attachment = await downloadAttachment(msg, m);
  if (!attachment) {
    // Unsupported or oversized media — keep the caption, it may still carry the ask.
    return m.body ? { ...base, body: m.body } : null;
  }

  if (attachment.kind === 'audio') {
    const text = await transcribe(attachment, m.id);
    if (!text) return null;
    log.debug(`voice note from ${m.author}: "${text.slice(0, 100)}"`);
    return { ...base, body: text, isVoiceNote: true };
  }

  if (attachment.kind === 'sheet') {
    const table = await sheetToText(attachment);
    if (!table) return m.body ? { ...base, body: m.body } : null;
    const label = attachment.filename ? `spreadsheet "${attachment.filename}"` : 'spreadsheet';
    return { ...base, body: [m.body, `(${label} contents)`, table].filter(Boolean).join('\n') };
  }

  // image | pdf — sent to the model as-is, alongside whatever caption came with it.
  return {
    ...base,
    body: m.body || '',
    attachments: [{ kind: attachment.kind, mime: attachment.mime, data: attachment.data, filename: attachment.filename }],
  };
}
