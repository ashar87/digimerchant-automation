/**
 * Reads a courier bill (Annie's "Shipping fee bills" sheet): from Excel exactly,
 * from a photo or PDF with Gemini. Same rule as invoices: a figure that can't
 * be read comes back blank, never guessed.
 *
 * Both readers produce the same raw rows, and one function (billFromRows)
 * turns them into bill lines, so a photo and an Excel copy of the same bill
 * give the same draft. On Annie's bill a row with an FBA ID is that shipment's
 * shipping; the "domestic shipping fee" row under it has no ID and belongs to
 * it; rows for the service fee and rate difference stand alone. A shipping row
 * with no FBA ID is goods going to a 3PL or home, which reach Amazon later in a
 * different shipment: an 'onward' line, held until that shipment is known.
 */
import ExcelJS from 'exceljs';
import { D } from '../landing/money.js';

const SYSTEM = `You read courier bills ("shipping fee bills") for a small Amazon seller that ships from China.
Copy exactly what is printed. Rules:
- If a number or ID is unclear, smudged, cut off or not printed, return null for it. Never estimate, infer, round or calculate a value that is not printed.
- One entry in "rows" per printed row that has an amount, in order, including domestic shipping fee rows, service fee rows and rate-difference rows. Leave the totals out of "rows".
- "fbaId" is the FBA shipment ID printed on that row (it looks like FBA15ABC123X or FBA19ABC123X). Return null if that row has none; never copy one from another row.
- "description" is any other words on the row that say what the amount is for, e.g. "domestic shipping fee", "1% of Annie service fee", "Last time payment rate difference".
- Amounts are RMB unless the bill says otherwise.`;

const num = { type: 'NUMBER', nullable: true };
const str = { type: 'STRING', nullable: true };

export const BILL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    agent: { ...str, description: 'Who issued the bill, if printed' },
    rows: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { ...str, description: 'As printed, converted to yyyy-mm-dd only if unambiguous' },
          fbaId: str,
          tracking: str,
          cartons: num,
          chargedWeight: num,
          service: { ...str, description: 'Shipping line / service type, e.g. USA airline included tax' },
          country: str,
          description: str,
          product: str,
          amount: num,
        },
        required: ['fbaId', 'amount'],
      },
    },
    totalRmb: num,
    totalUsd: num,
    rmbPerUsd: { ...num, description: 'The exchange rate printed on the bill (RMB per USD), e.g. "Today rate 6.63"' },
  },
  required: ['rows', 'totalRmb'],
};

/** A reader built on the configured Gemini provider. Tests pass their own `read`. */
export function geminiBillReader(provider) {
  return {
    name: 'gemini',
    async read({ mime, data }) {
      const kind = mime === 'application/pdf' ? 'pdf' : 'image';
      const out = await provider.readJson({
        system: SYSTEM,
        text: 'Read this courier bill. Return null for anything you cannot read with certainty.',
        attachments: [{ kind, mime, data }],
        schema: BILL_SCHEMA,
        job: 'courier bill',
        label: kind === 'pdf' ? 'Courier bill PDF' : 'Courier bill photo',
      });
      return { ...out.data, model: out.model };
    },
  };
}

const DOMESTIC = /domestic|国内|内陆|提货|pick\s*-?up/i;
const FEE = /service\s*fee|服务费|手续费|bank\s*fee/i;
const RATE_DIFF = /rate\s*diff|exchange|汇率|差额|payment\s*difference/i;
const EXPENSE = /sample|样品/i;

// Letters and digits a photo reader mixes up. Two IDs that match once these are
// folded together are taken to be the same shipment.
const fold = (id) => String(id).toUpperCase().replace(/O/g, '0').replace(/I/g, '1').replace(/B/g, '8').replace(/S/g, '5').replace(/Z/g, '2');

/** The shipment on file an ID as read refers to: itself, or the one ID that differs only by look-alike characters. */
export function matchShipment(read, shipmentIds) {
  if (!read) return { id: null };
  const id = String(read).toUpperCase().replace(/\s+/g, '');
  if (shipmentIds.includes(id)) return { id, onFile: true };
  const near = shipmentIds.filter((s) => fold(s) === fold(id));
  if (near.length === 1) return { id: near[0], onFile: true, readAs: id };
  return { id, onFile: false };
}

/**
 * Raw rows (from either reader) → bill lines, with notes for the checks.
 * `shipmentIds` are the FBA shipments on file.
 */
export function billFromRows(raw, shipmentIds = []) {
  const v = (x) => (x === null || x === undefined || x === '' || Number.isNaN(Number(x)) ? null : D(x).toString());
  const notes = [];
  const lines = [];
  let last = null; // the shipping line the next domestic fee belongs to
  (raw.rows || []).forEach((r, i) => {
    const text = [r.service, r.country, r.description].filter(Boolean).join(' · ');
    const rmb = v(r.amount);
    const match = matchShipment(r.fbaId, shipmentIds);
    if (match.readAs) notes.push({ severity: 'ok', message: `Line ${i + 1}: read as ${match.readAs}; taken as ${match.id}, the shipment on file it matches.` });
    else if (match.id && !match.onFile) notes.push({ severity: 'warning', message: `Line ${i + 1}: ${match.id} isn't a shipment on file yet. Check the ID, and add the shipment on the Shipments page (the Amazon check fills in its details) so the bill's cost reaches it.` });

    let line;
    if (DOMESTIC.test(text)) {
      const shipment = match.id || last?.shipment;
      line = { kind: last?.kind === 'onward' && !match.id ? 'onward' : 'domestic', shipment, rmb, description: 'Domestic shipping fee' };
      if (!match.id && last) notes.push({ severity: 'ok', message: `Line ${i + 1}: domestic shipping fee, taken as ${last.shipment || 'the line above'}’s (no FBA ID on its row).` });
      if (!match.id && !last) notes.push({ severity: 'warning', message: `Line ${i + 1}: domestic shipping fee with no FBA ID and no shipment above it. It's shared across the bill's shipments unless you name one.` });
    } else if (FEE.test(text)) line = { kind: 'fee', shipment: match.id || undefined, rmb, description: text };
    else if (RATE_DIFF.test(text)) line = { kind: 'adjustment', shipment: match.id || undefined, rmb, description: text };
    else if (EXPENSE.test(text)) line = { kind: 'expense', rmb, description: text };
    else if (match.id) line = { kind: 'shipping', shipment: match.id, rmb };
    else if (r.service || r.country || r.tracking || r.cartons) {
      line = { kind: 'onward', rmb, description: [r.country, r.service].filter(Boolean).join(' · ') || 'a 3PL or home' };
      notes.push({ severity: 'warning', message: `Line ${i + 1}: shipping with no FBA ID, so it's taken as goods going to a 3PL or home. It stays out of landing cost until you add the FBA shipment they go to Amazon in. If the ID is just hard to read, enter it.` });
    } else {
      line = { kind: 'adjustment', rmb, description: text || 'Unlabelled line' };
      notes.push({ severity: 'warning', message: `Line ${i + 1}: couldn't tell what this ${rmb ?? ''} RMB is for. Choose its kind and say what it is.` });
    }
    if (rmb === null) notes.push({ severity: 'warning', message: `Line ${i + 1}: the amount couldn’t be read. Enter it from the bill.` });
    if (line.kind === 'shipping' || line.kind === 'onward') last = line;
    if (r.product) line.product = r.product;
    lines.push(Object.fromEntries(Object.entries(line).filter(([, x]) => x !== undefined && x !== null && x !== '')));
  });
  const unread = [];
  if (raw.totalRmb === null || raw.totalRmb === undefined) unread.push('Bill total (RMB)');
  if (raw.rmbPerUsd === null || raw.rmbPerUsd === undefined) unread.push('Exchange rate');
  return {
    agent: raw.agent || null,
    lines,
    statedTotalRmb: v(raw.totalRmb),
    totalUsd: v(raw.totalUsd),
    rmbPerUsd: v(raw.rmbPerUsd),
    notes,
    unread,
  };
}

/* ---------------------------- Excel ---------------------------- */

const HEAD = {
  date: /date|日期/i,
  fbaId: /fba/i,
  tracking: /tracking|转单号|运单号/i,
  cartons: /cartons?|件数/i,
  chargedWeight: /weight|收费重|重量/i,
  service: /service|shipping\s*line|服务类型|渠道/i,
  country: /country|发往国家|国家/i,
  amount: /amount|金额|费用/i,
  product: /product|品名/i,
};
const TOTAL_RMB = /人民币总计|total(ly)?\s*rmb|合计|总计/i;
const TOTAL_USD = /usd|美金|美元/i;
const RATE = /rate\s*[:：]?\s*(\d+(?:\.\d+)?)|汇率\s*[:：]?\s*(\d+(?:\.\d+)?)/i;

/** Reads the bill straight from the cells: no model involved. */
export async function readExcelBill(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  for (const sheet of wb.worksheets) {
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row) => rows.push(row.values.slice(1).map(cell)));
    const found = rawFromCells(rows);
    if (found) return { ...found, sourceText: rows.filter((r) => r.some((c) => c !== null)).map((r) => r.map((c) => (c === null ? '' : String(c))).join(' | ')).join('\n') };
  }
  return null;
}

/** Cells (rows of values) → the raw shape the model returns, or null if there's no bill table. */
export function rawFromCells(rows) {
  const headerAt = rows.findIndex((r) => r.some((c) => typeof c === 'string' && HEAD.fbaId.test(c)) && r.some((c) => typeof c === 'string' && HEAD.amount.test(c)));
  if (headerAt < 0) return null;
  const col = {};
  rows[headerAt].forEach((c, i) => {
    if (typeof c !== 'string') return;
    for (const [key, re] of Object.entries(HEAD)) if (col[key] === undefined && re.test(c)) { col[key] = i; break; }
  });
  const out = { rows: [], totalRmb: null, totalUsd: null, rmbPerUsd: null };
  let product = null;
  for (const r of rows.slice(headerAt + 1)) {
    const at = (key) => (col[key] === undefined ? null : r[col[key]] ?? null);
    const amount = number(at('amount'));
    if (amount === null) continue;
    // Words on the row outside the known columns: fee labels, totals, the rate.
    const known = new Set(Object.values(col));
    const words = r.filter((c, i) => typeof c === 'string' && c.trim() && !known.has(i)).join(' ');
    const labelled = [words, typeof at('service') === 'string' ? at('service') : '', typeof at('country') === 'string' ? at('country') : ''].join(' ');
    if (!at('fbaId') && TOTAL_USD.test(labelled) && !TOTAL_RMB.test(labelled)) {
      out.totalUsd = amount;
      const m = RATE.exec(labelled);
      if (m) out.rmbPerUsd = Number(m[1] || m[2]);
      continue;
    }
    if (!at('fbaId') && TOTAL_RMB.test(labelled)) {
      out.totalRmb = amount;
      continue;
    }
    if (at('product')) product = String(at('product'));
    out.rows.push({
      date: isoDate(at('date')),
      fbaId: at('fbaId') ? String(at('fbaId')).trim() : null,
      tracking: at('tracking') === null ? null : String(at('tracking')),
      cartons: number(at('cartons')),
      chargedWeight: number(at('chargedWeight')),
      service: at('service') === null ? null : String(at('service')),
      country: at('country') === null ? null : String(at('country')),
      description: words || null,
      product,
      amount,
    });
  }
  return out;
}

function cell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cell(v.result);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    return null;
  }
  return typeof v === 'string' ? v.trim() || null : v;
}

function number(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[,¥￥\s]|RMB|元/gi, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

function isoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;
}
