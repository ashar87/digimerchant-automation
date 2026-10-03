/**
 * Every invoice, uploaded on the dashboard or forwarded to the WhatsApp
 * self-chat, comes in here: the original file is kept, it's read (Excel
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
import { enqueue } from '../notify/outbox.js';
import { fmtRmb } from '../landing/money.js';

export const INVOICE_DIR = process.env.INVOICE_DIR || path.join(path.dirname(config.landingDbPath), 'invoices');
const EXCEL = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
const MODEL = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_BYTES = 15 * 1024 * 1024;
const PO = /\bPO-\d{1,5}\b/i;
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

export async function intakeInvoice({ db, buffer, filename, mime, source, actor, po = null, reader = null, dir = INVOICE_DIR }) {
  if (!buffer?.length) throw new Error('The file is empty');
  if (buffer.length > MAX_BYTES) throw new Error('The file is over 15 MB');
  mime = mimeFor(filename, mime);
  if (!EXCEL.has(mime) && !MODEL.has(mime)) throw new Error(`Can't read ${mime} invoices: send Excel (.xlsx), PDF or a photo`);

  // Kept by content hash: the same file forwarded twice is stored once.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const ext = path.extname(filename || '').toLowerCase() || { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[mime] || '';
  const filePath = path.join(dir, `${hash}${ext}`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer, { mode: 0o600 });

  let reading;
  try {
    if (EXCEL.has(mime)) reading = await readExcelInvoice(buffer);
    else if (reader) reading = normaliseModelReading(await reader.read({ mime, data: buffer.toString('base64') }));
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
  reading.checks = checkReading(reading);

  const res = db
    .prepare('INSERT INTO invoice_drafts (created_at, created_by, source, file_path, filename, mime, po, reading) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, source, path.relative(ROOT, filePath), filename || null, mime, po, JSON.stringify(reading));
  return getDraft(db, Number(res.lastInsertRowid));
}

/**
 * The hook for the WhatsApp listener: call it when a document or photo is
 * posted in the self-chat with a caption starting "invoice" (e.g. "invoice
 * PO-020"). Not wired into the running listener yet.
 *
 *   if (isSelfChat && msg.hasMedia && /^invoice\b/i.test(msg.body)) {
 *     const media = await downloadMediaDirect(msg);
 *     await handleForwardedInvoice({ db: landingDb, media, caption: msg.body, reader });
 *   }
 */
export async function handleForwardedInvoice({ db, media, caption = '', actor = 'whatsapp', reader = null, dir = INVOICE_DIR }) {
  const po = caption.match(PO)?.[0]?.toUpperCase() || null;
  const draft = await intakeInvoice({ db, buffer: Buffer.from(media.data, 'base64'), filename: media.filename || 'invoice', mime: media.mimetype, source: 'whatsapp', actor, po, reader, dir });
  const r = draft.reading;
  const problems = r.checks.filter((c) => c.severity !== 'ok');
  const text = [
    `🧾 Invoice received${po ? ` for ${po}` : ''}${media.filename ? ` (${media.filename})` : ''}`,
    r.lines.length ? `${r.lines.length} line(s)${r.statedTotalRmb ? `, total ${fmtRmb(r.statedTotalRmb)} RMB` : ''}.` : 'Nothing could be read from it.',
    problems.length ? `⚠️ ${problems.length} thing(s) to check, e.g. ${problems[0].message}` : r.lines.length ? 'The arithmetic adds up.' : null,
    `Check and save it on the dashboard (Inbox → invoice ${draft.id}).`,
  ].filter(Boolean);
  enqueue(db, { kind: 'invoice_received', dedupeKey: `invoice:${draft.id}`, text: text.join('\n') });
  return draft;
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
