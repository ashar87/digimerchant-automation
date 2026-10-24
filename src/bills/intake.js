/**
 * Every courier bill uploaded on the dashboard comes in here, the same way
 * invoices do: the original file is kept, it's read (Excel exactly, PDFs and
 * photos by Gemini), checked by plain arithmetic, and saved as a draft that a
 * person checks before it becomes a courier bill.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { loadLedger } from '../landing/store.js';
import { INVOICE_DIR, mimeFor } from '../invoices/intake.js';
import { readExcelBill, billFromRows } from './read.js';
import { checkBill, totalWithoutFee } from './checks.js';
import { syncAmazon } from '../amazon/sync.js';

const EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MODEL = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_BYTES = 15 * 1024 * 1024;

/** "WhatsApp Image 2026-10-02 at 15.17.29.jpeg" → 2026-10-02: the day Annie sent it. */
const dateInName = (filename = '') => /(20\d{2}-\d{2}-\d{2})/.exec(filename)?.[1] || null;

/** The shipments on file, as the reader wants them: marketplace, created date, and whether a bill already covers each. */
function shipmentsOnFile(db) {
  const ledger = loadLedger(db);
  const billed = new Set(ledger.courierBills.flatMap((b) => b.lines.map((l) => l.shipment)).filter(Boolean));
  return ledger.shipments.map((s) => ({ id: s.id, marketplace: s.marketplace, createdAt: s.createdAt, billed: billed.has(s.id), po: [...new Set(s.items.map((i) => i.po).filter(Boolean))].join(', ') }));
}

/**
 * Bills come some time after their shipments are created, so an FBA ID on the
 * bill that isn't on the dashboard yet is looked up at Amazon and added (linked
 * to its PO by the PO in its name) before the bill is read against the list.
 */
async function addShipmentsFromAmazon(db, amazon, raw, shipments) {
  const known = new Set(shipments.map((s) => s.id));
  const ids = [...new Set(billFromRows(raw, shipments).lines.map((l) => l.shipment).filter((id) => id && !known.has(id)))];
  if (!ids.length || !amazon) return [];
  try {
    const r = await syncAmazon({ db, client: amazon, only: ids, actor: 'amazon (courier bill)' });
    const added = new Set([...r.created, ...r.updated]);
    const now = shipmentsOnFile(db);
    return [
      ...ids.filter((id) => added.has(id)).map((id) => {
        const s = now.find((x) => x.id === id);
        return { id, severity: 'ok', message: `${id} wasn’t on the dashboard: added from Amazon${s?.po ? `, linked to ${s.po}` : ', not linked to a PO yet (link it on its Shipments page)'}.` };
      }),
      ...ids.filter((id) => !added.has(id)).map((id) => ({ id, severity: 'warning', message: `Amazon has no shipment ${id} on this account: check the ID on the bill.` })),
      ...r.errors.map((e) => ({ severity: 'warning', message: `Looking up the bill’s shipments at Amazon: ${e}` })),
    ];
  } catch (err) {
    return [{ severity: 'warning', message: `Couldn’t look up ${ids.join(', ')} at Amazon (${err.message}); add them on the Shipments page.` }];
  }
}

export async function intakeBill({ db, buffer, filename, mime, source = 'upload', actor, reader = null, amazon = null, dir = INVOICE_DIR, today = new Date().toISOString().slice(0, 10) }) {
  if (!buffer?.length) throw new Error('The file is empty');
  if (buffer.length > MAX_BYTES) throw new Error('The file is over 15 MB');
  mime = mimeFor(filename, mime);
  if (mime !== EXCEL && !MODEL.has(mime)) throw new Error(`Can't read ${mime} bills: send Excel (.xlsx), PDF or a photo`);

  // Kept by content hash next to the invoices, so the nightly backup covers it.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const ext = path.extname(filename || '').toLowerCase() || { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[mime] || '';
  const filePath = path.join(dir, `${hash}${ext}`);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, buffer, { mode: 0o600 });

  let reading;
  try {
    let raw = null;
    let method;
    if (mime === EXCEL) {
      raw = await readExcelBill(buffer);
      method = 'excel';
    } else if (reader) {
      raw = await reader.read({ mime, data: buffer.toString('base64') });
      method = 'model';
    }
    if (raw) {
      const looked = await addShipmentsFromAmazon(db, amazon, raw, shipmentsOnFile(db));
      const read = billFromRows(raw, shipmentsOnFile(db));
      // Once Amazon has been asked, its answer replaces the general "not on the dashboard" note.
      const asked = looked.map((n) => n.id).filter(Boolean);
      const notes = read.notes.filter((n) => !asked.some((id) => n.message.includes(`${id} isn't on the dashboard`)));
      reading = { method, ...(raw.model ? { model: raw.model } : {}), ...read, notes: [...looked, ...notes], ...(raw.sourceText ? { sourceText: raw.sourceText } : {}) };
    } else if (method === 'excel') reading = { method, lines: [], unread: ['The bill’s lines (no FBA ID / amount columns found)'] };
    else reading = { method: 'none', lines: [], unread: ['Everything: bill reading by Gemini is not set up, so enter the lines by hand'] };
  } catch (err) {
    reading = { method: 'failed', error: err.message, lines: [], unread: [`Everything: reading failed (${err.message}); enter the lines by hand`] };
  }
  reading.date = dateInName(filename) || today;
  const fullTotal = totalWithoutFee(reading);
  if (fullTotal) {
    reading.printedTotalRmb = reading.statedTotalRmb;
    reading.statedTotalRmb = fullTotal;
  }
  reading.checks = checkBill(reading);

  const res = db
    .prepare('INSERT INTO bill_drafts (created_at, created_by, source, file_path, filename, mime, reading) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), actor, source, path.relative(ROOT, filePath), filename || null, mime, JSON.stringify(reading));
  return getBillDraft(db, Number(res.lastInsertRowid));
}

const parse = (row) => row && { ...row, reading: JSON.parse(row.reading || '{}') };

export const getBillDraft = (db, id) => parse(db.prepare('SELECT * FROM bill_drafts WHERE id = ?').get(id));
export const pendingBillDrafts = (db) => db.prepare("SELECT * FROM bill_drafts WHERE status = 'pending' ORDER BY id").all().map(parse);

export function closeBillDraft(db, id, status, savedAs = null) {
  db.prepare('UPDATE bill_drafts SET status = ?, saved_as = ? WHERE id = ?').run(status, savedAs, id);
}
