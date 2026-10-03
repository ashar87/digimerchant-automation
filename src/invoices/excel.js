/**
 * Reads a supplier invoice from Excel exactly: no model involved. Finds the
 * header row (quantity / unit price / amount, in English or Chinese), takes
 * the rows under it as lines until the total, then looks below for the
 * deposit and balance.
 */
import ExcelJS from 'exceljs';
import { D } from '../landing/money.js';
import { guessKind } from './match.js';

const HEAD = {
  description: /description|item|product|name|goods|品名|名称|货物|产品|描述/i,
  qty: /qty|quantity|pcs|数量/i,
  unitPrice: /unit\s*price|price|单价/i,
  rmb: /amount|total|金额|总价|小计/i,
};
const TOTAL = /^(grand\s*)?total|合计|总计|总金额/i;
const DEPOSIT = /deposit|定金|订金|预付/i;
const RECEIVED = /received|已付|已收/i;
const BALANCE = /balance|尾款|余款/i;
const DATE = /date|日期/i;
const INVOICE_NO = /invoice\s*(no|number|#)|发票号|单号|PI\s*no/i;
const SHIP_TO = /(ship\s*to|destination|market(?:place)?|目的地|目的国)\s*[:：]?\s*(.*)$/i;

export async function readExcelInvoice(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  for (const sheet of wb.worksheets) {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map(cellValue)));
    const found = readRows(rows);
    if (found) return { ...found, method: 'excel', sheet: sheet.name, sourceText: rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join(' | ')).join('\n') };
  }
  return { method: 'excel', lines: [], unread: ['Invoice lines'], sourceText: '' };
}

export function readRows(rows) {
  const headerAt = rows.findIndex((r) => {
    const t = r.map((c) => (typeof c === 'string' ? c : ''));
    return t.some((c) => HEAD.qty.test(c)) && t.some((c) => HEAD.rmb.test(c));
  });
  if (headerAt < 0) return null;
  const header = rows[headerAt].map((c) => (typeof c === 'string' ? c : ''));
  const col = (re, avoid = []) => header.findIndex((h, i) => re.test(h) && !avoid.includes(i));
  const qtyCol = col(HEAD.qty);
  const unitCol = col(HEAD.unitPrice, [qtyCol]);
  const amountCol = header.reduce((best, h, i) => (HEAD.rmb.test(h) && i !== unitCol && i !== qtyCol ? i : best), -1); // rightmost amount column
  let descCol = col(HEAD.description, [qtyCol, unitCol, amountCol]);

  const out = { lines: [], statedTotalRmb: null, depositPercent: null, depositRmb: null, depositReceivedRmb: null, balanceRmb: null, unread: [] };

  // Header details above the table: date and invoice number.
  for (const r of rows.slice(0, headerAt)) {
    r.forEach((c, i) => {
      if (typeof c !== 'string') return;
      const next = r.slice(i + 1).find((x) => x !== null && x !== '');
      if (DATE.test(c) && !out.date) out.date = toIsoDate(next) || toIsoDate(c.split(/[:：]/)[1]);
      if (INVOICE_NO.test(c) && !out.invoiceNumber && next !== undefined) out.invoiceNumber = String(next);
      const ship = SHIP_TO.exec(c);
      if (ship && !out.marketplaceAsPrinted) out.marketplaceAsPrinted = (ship[2] || (next !== undefined ? String(next) : '')).trim() || undefined;
    });
  }

  let i = headerAt + 1;
  for (; i < rows.length; i++) {
    const r = rows[i];
    const text = r.filter((c) => typeof c === 'string').join(' ');
    if (TOTAL.test(text.trim()) || r.some((c) => typeof c === 'string' && TOTAL.test(c.trim()))) {
      out.statedTotalRmb = num(r[amountCol]) ?? lastNumber(r);
      i++;
      break;
    }
    const qty = num(r[qtyCol]);
    const amount = num(r[amountCol]);
    const unit = unitCol >= 0 ? num(r[unitCol]) : null;
    const description = descCol >= 0 && typeof r[descCol] === 'string' ? r[descCol] : r.find((c) => typeof c === 'string' && !/^\d/.test(c)) || '';
    if (qty === null && amount === null) continue; // blank or heading row inside the table
    const pctMatch = /(\d{1,2})\s*%/.exec(description);
    const kind = guessKind(description);
    out.lines.push({ description: description.trim(), qty, unitPrice: unit, rmb: amount, kind, ...(pctMatch && kind === 'fee' ? { feePercent: pctMatch[1] } : {}) });
  }

  // Below the total: deposit requested or received, and the balance.
  for (; i < rows.length; i++) {
    const r = rows[i];
    const text = r.filter((c) => typeof c === 'string').join(' ');
    const value = lastNumber(r);
    if (value === null) continue;
    if (DEPOSIT.test(text) && RECEIVED.test(text)) out.depositReceivedRmb = value;
    else if (DEPOSIT.test(text)) {
      out.depositRmb = value;
      const p = /(\d{1,2})\s*%/.exec(text);
      if (p) out.depositPercent = p[1];
    } else if (BALANCE.test(text)) out.balanceRmb = value;
  }
  if (out.statedTotalRmb === null) out.unread.push('Invoice total');
  out.kindGuess = out.depositReceivedRmb !== null || out.balanceRmb !== null ? 'final' : 'proforma';
  return out;
}

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result !== undefined) return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : v.result; // formula
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return String(v.text);
    return null;
  }
  return typeof v === 'string' ? v.trim() : v;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? D(v).toString() : null;
  const s = String(v).replace(/[,¥￥$\s]|RMB|CNY|元/gi, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? D(s).toString() : null;
}

function lastNumber(r) {
  for (let i = r.length - 1; i >= 0; i--) {
    const v = num(r[i]);
    if (v !== null && !(typeof r[i] === 'string' && /%/.test(r[i]))) return v;
  }
  return null;
}

function toIsoDate(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // dd/mm/yyyy, as Chinese suppliers and the UK write it
  return undefined;
}
