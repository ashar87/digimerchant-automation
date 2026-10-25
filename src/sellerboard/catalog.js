/**
 * Sellerboard's own product list, from its Products → Export file, one per
 * Sellerboard account. The feed copies every column it doesn't set itself
 * (title, labels, VAT, Hide, EAN…) from here, so an import can only ever add a
 * batch and never blanks a product's settings.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { accountOf, HEADERS, MARKETPLACE_CODES } from './feed.js';

/**
 * Sellerboard's files carry a comment and header-footer drawings that exceljs
 * can't load, so those parts are taken out first; the cells are untouched.
 */
async function withoutDrawings(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/(drawings\/|comments\d*\.xml)/.test(name)) zip.remove(name);
    if (/^xl\/worksheets\/_rels\/.*\.rels$/.test(name)) {
      const rels = await zip.file(name).async('string');
      zip.file(name, rels.replace(/<Relationship [^>]*Type="[^"]*\/(drawing|vmlDrawing|comments)"[^>]*\/>/g, ''));
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      const sheet = await zip.file(name).async('string');
      zip.file(name, sheet.replace(/<(drawing|legacyDrawing|legacyDrawingHF)\b[^>]*\/>/g, ''));
    }
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

const cellValue = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return `${String(v.getUTCDate()).padStart(2, '0')}/${String(v.getUTCMonth() + 1).padStart(2, '0')}/${v.getUTCFullYear()}`;
  if (typeof v === 'object') return v.text ?? v.result ?? (v.richText ? v.richText.map((t) => t.text).join('') : null);
  return typeof v === 'string' ? v.trim() || null : v;
};

/**
 * Reads a Sellerboard product export: one row per SKU per marketplace, as
 * { header: value } for Sellerboard's columns. Says which account it's from
 * by its marketplaces.
 */
export async function readSellerboardExport(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await withoutDrawings(buffer));
  } catch {
    throw new Error('That isn’t an Excel file: upload the .xlsx from Sellerboard’s Products → Export');
  }
  const ws = wb.worksheets[0];
  const headers = (ws?.getRow(1).values || []).slice(1).map(cellValue);
  const missing = HEADERS.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`This doesn’t look like Sellerboard’s product export: no ${missing.join(', ')} column`);

  const rows = [];
  const seen = new Set();
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const values = Object.fromEntries(HEADERS.map((h) => [h, cellValue(row.getCell(headers.indexOf(h) + 1).value)]));
    if (!values.SKU) return;
    const key = `${values.Marketplace || ''}|${values.SKU}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(values);
  });
  const accounts = [...new Set(rows.map((r) => accountOf(MARKETPLACE_CODES[r.Marketplace])).filter(Boolean))];
  if (accounts.length > 1) throw new Error('This file has US and UK/DE products together; each Sellerboard account exports its own');
  return { account: accounts[0] || null, rows };
}

export function saveCatalog(db, { account, rows, filename, actor, now = new Date() }) {
  db.prepare('INSERT INTO sellerboard_catalogs (account, uploaded_at, uploaded_by, filename, rows) VALUES (?, ?, ?, ?, ?) ON CONFLICT (account) DO UPDATE SET uploaded_at = excluded.uploaded_at, uploaded_by = excluded.uploaded_by, filename = excluded.filename, rows = excluded.rows')
    .run(account, now.toISOString(), actor, filename || null, JSON.stringify(rows));
}

/** { account: { uploadedAt, uploadedBy, count, rows: Map('Amazon.de|SKU' → values) } } */
export function loadCatalog(db) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM sellerboard_catalogs').all()) {
    const rows = JSON.parse(r.rows);
    out[r.account] = { uploadedAt: r.uploaded_at, uploadedBy: r.uploaded_by, count: rows.length, rows: new Map(rows.map((v) => [`${v.Marketplace || ''}|${v.SKU}`, v])) };
  }
  return out;
}
