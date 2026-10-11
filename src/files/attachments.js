/**
 * Documents attached to records: supplier invoices, Wise receipts, courier
 * bills, packing lists. Files are kept under data/files by content hash (the
 * same file attached twice is stored once), readable only by the service.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const FILES_DIR = process.env.FILES_DIR || path.join(path.dirname(config.landingDbPath), 'files');
export const MAX_BYTES = 15 * 1024 * 1024;
export const ENTITIES = ['order', 'invoice', 'payment', 'courier_bill'];

const TYPES = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
// Opened in the browser. Everything else downloads, so an uploaded file can never run as a page here.
const INLINE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

export const ACCEPT = Object.keys(TYPES).join(',');

/** The type is decided by the file's extension, never by what the browser claims. */
export function typeFor(filename) {
  return TYPES[path.extname(String(filename || '')).toLowerCase()] || null;
}

export function addAttachment(db, { entity, entityId, buffer, filename, note = null, actor, dir = FILES_DIR }) {
  if (!ENTITIES.includes(entity)) throw new Error(`Can't attach files to a ${entity}`);
  if (!buffer?.length) throw new Error('The file is empty');
  if (buffer.length > MAX_BYTES) throw new Error('The file is over 15 MB');
  const mime = typeFor(filename);
  if (!mime) throw new Error(`Attach a PDF, photo (JPG, PNG, WebP, HEIC), Excel, CSV or Word file, not ${path.extname(filename || '') || 'this kind of file'}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const file = path.join(dir, `${hash}${path.extname(filename).toLowerCase()}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer, { mode: 0o600 });
  const at = new Date().toISOString();
  const name = path.basename(String(filename)).slice(0, 200);
  return db.transaction(() => {
    const id = Number(
      db.prepare('INSERT INTO attachments (entity, entity_id, file, filename, mime, size, note, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(entity, entityId, path.basename(file), name, mime, buffer.length, note || null, at, actor).lastInsertRowid
    );
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)').run(at, actor, 'attach', entity, entityId, JSON.stringify({ attachment: id, filename: name }));
    return id;
  })();
}

export const listAttachments = (db, entity, entityId) => db.prepare('SELECT * FROM attachments WHERE entity = ? AND entity_id = ? ORDER BY id').all(entity, entityId);
export const getAttachment = (db, id) => db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);

export function removeAttachment(db, id, { actor, dir = FILES_DIR }) {
  const a = getAttachment(db, id);
  if (!a) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)').run(new Date().toISOString(), actor, 'detach', a.entity, a.entity_id, JSON.stringify({ attachment: id, filename: a.filename }));
  })();
  // The file goes too, unless another record still uses the same one.
  if (!db.prepare('SELECT 1 FROM attachments WHERE file = ?').get(a.file)) fs.rmSync(path.join(dir, a.file), { force: true });
  return true;
}

/** The file's bytes and how to serve them. Only ever reads from the files folder. */
export function readAttachment(a, dir = FILES_DIR) {
  const file = path.resolve(dir, a.file);
  if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) return null;
  return { body: fs.readFileSync(file), type: a.mime, disposition: INLINE.has(a.mime) ? 'inline' : 'attachment' };
}

export const contentDisposition = (kind, filename) => `${kind}; filename="${String(filename || 'file').replace(/[^\w.\- ]/g, '_')}"`;
export const isInline = (mime) => INLINE.has(mime);
