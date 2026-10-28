/**
 * Every invoice, uploaded on the dashboard or posted in the supplier group on
 * WhatsApp (src/intake/), comes in here: the original file is kept, it's read (Excel
 * exactly, PDFs and photos by Gemini), checked by plain arithmetic, and saved
 * as a draft that a person checks before it becomes part of an order.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../config.js';
import { loadLedger } from '../landing/store.js';
import { readExcelInvoice } from './excel.js';
import { normaliseModelReading } from './model.js';
import { checkReading } from './checks.js';
import { suggestProduct } from './match.js';

export const INVOICE_DIR = process.env.INVOICE_DIR || path.join(path.dirname(config.landingDbPath), 'invoices');
const EXCEL = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const MODEL = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_BYTES = 15 * 1024 * 1024;
const MARKETS = [
  [/\b(usa?|united states|america|美国)\b/i, 'US'],
  [/\b(uk|united kingdom|england|britain|英国)\b/i, 'UK'],
  [/\b(de|germany|deutschland|德国)\b/i, 'DE'],
];

export function mimeFor(filename = '', given = '') {
  if (given && given !== 'application/octet-stream') return given;
  const ext = path.extname(filename).toLowerCase();
  return { '.xlsx': [...EXCEL][0], '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' }[ext] || given || 'application/octet-stream';
}

/** Keeps a file in the invoice folder by content hash (the same file sent twice is stored once). Returns its path. */
export function keepFile(buffer, filename, mime, dir = INVOICE_DIR) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const ext = path.extname(filename || '').toLowerCase() || { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[mime] || '';
  const filePath = path.join(dir, `${hash}${ext}`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return filePath;
}

/**
 * The order an invoice belongs to when the supplier prints no invoice number:
 * the order date and market in its Date column ("2026/10/5-UK 英国" →
 * "2026-10-05 UK"). The deposit invoice, its corrected versions and the balance
 * invoice all carry it, so it's kept as the supplier ref.
 */
export const orderRef = (r) => (r.orderDate && r.marketplace ? `${r.orderDate} ${r.marketplace}` : null);

/**
 * `pages` are further photos of the same invoice ([{ buffer, filename, mime }]),
 * e.g. page 2 sent as its own image: read together with the first, kept beside it.
 */
export async function intakeInvoice({ db, buffer, filename, mime, source, actor, po = null, reader = null, dir = INVOICE_DIR, pages = [], messageId = null }) {
  if (!buffer?.length) throw new Error('The file is empty');
  if (buffer.length > MAX_BYTES) throw new Error('The file is over 15 MB');
  mime = mimeFor(filename, mime);
  if (!EXCEL.has(mime) && !MODEL.has(mime)) throw new Error(`Can't read ${mime} invoices: send Excel (.xlsx), PDF or a photo`);
  pages = pages.map((p) => ({ ...p, mime: mimeFor(p.filename, p.mime) })).filter((p) => p.buffer?.length && MODEL.has(p.mime));

  const filePath = keepFile(buffer, filename, mime, dir);
  const pagePaths = pages.map((p) => path.relative(ROOT, keepFile(p.buffer, p.filename, p.mime, dir)));

  let reading;
  try {
    if (EXCEL.has(mime)) reading = await readExcelInvoice(buffer);
    else if (reader) reading = normaliseModelReading(await reader.read({ mime, data: buffer.toString('base64'), more: pages.map((p) => ({ mime: p.mime, data: p.buffer.toString('base64') })) }));
    else reading = { method: 'none', lines: [], unread: ['Everything: invoice reading by Gemini is not set up, so enter the lines by hand'] };
  } catch (err) {
    reading = { method: 'failed', error: err.message, lines: [], unread: [`Everything: reading failed (${err.message}); enter the lines by hand`] };
  }

  const ledger = loadLedger(db);
  const marketplace = MARKETS.find(([re]) => re.test(reading.marketplaceAsPrinted || ''))?.[1] || null;
  const order = po ? ledger.orders.find((o) => o.po === po) : null;
  const mkt = order?.marketplace || marketplace;
  for (const line of reading.lines) if (line.kind === 'goods' || line.kind === 'labour') line.product = suggestProduct(line.description, ledger.products, mkt);
  reading.marketplace = mkt;
  reading.orderRef = orderRef(reading);
  reading.checks = checkReading(reading);
  if (pagePaths.length) reading.pages = pagePaths;

  const res = db
    .prepare('INSERT INTO invoice_drafts (created_at, created_by, source, file_path, filename, mime, po, reading, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, source, path.relative(ROOT, filePath), filename || null, mime, po, JSON.stringify(reading), messageId);
  return getDraft(db, Number(res.lastInsertRowid));
}

export function getDraft(db, id) {
  const row = db.prepare('SELECT * FROM invoice_drafts WHERE id = ?').get(id);
  return row ? { ...row, reading: JSON.parse(row.reading || '{}') } : null;
}

export function pendingDrafts(db) {
  return db.prepare("SELECT * FROM invoice_drafts WHERE status = 'pending' ORDER BY id").all().map((row) => ({ ...row, reading: JSON.parse(row.reading || '{}') }));
}

export function closeDraft(db, id, status, savedAs = null) {
  db.prepare('UPDATE invoice_drafts SET status = ?, saved_as = ? WHERE id = ?').run(status, savedAs, id);
}

/** A file of a draft (0 = the original, 1… = further pages), only ever from the invoice folder. */
export function draftFilePath(draft, page = 0) {
  const rel = page ? draft.reading?.pages?.[page - 1] : draft.file_path;
  if (!rel) return null;
  const file = path.resolve(ROOT, rel);
  return file.startsWith(path.resolve(INVOICE_DIR) + path.sep) && fs.existsSync(file) ? file : null;
}
