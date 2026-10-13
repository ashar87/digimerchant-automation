/**
 * Amazon's Inventory Ledger (report GET_LEDGER_DETAIL_VIEW_DATA): every unit
 * movement, including each receipt with the FBA shipment it came in on. The
 * earliest receipt is the day Amazon started receiving a shipment: the start
 * date Sellerboard's FIFO batches need.
 */
export const LEDGER_REPORT = 'GET_LEDGER_DETAIL_VIEW_DATA';

const unquote = (v) => String(v ?? '').replace(/^"|"$/g, '');

/** FBA shipment id -> { date: 'yyyy-mm-dd', units }, from the report's tab-separated text. */
export function receiptsByShipment(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return new Map();
  const head = lines[0].split('\t').map(unquote);
  const col = (name) => head.indexOf(name);
  const [type, ref, qty, date, stamp] = ['Event Type', 'Reference ID', 'Quantity', 'Date', 'Date and Time'].map(col);
  const out = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split('\t').map(unquote);
    if (cells[type] !== 'Receipts' || !/^FBA[A-Z0-9]+$/.test(cells[ref] || '')) continue;
    // "Date and Time" is ISO (2026-09-28T01:00:00+0100); "Date" is month/day/year.
    const iso = /^\d{4}-\d{2}-\d{2}/.test(cells[stamp] || '') ? cells[stamp].slice(0, 10) : (cells[date] || '').replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const r = out.get(cells[ref]) || { date: iso, units: 0 };
    if (iso < r.date) r.date = iso;
    r.units += Number(cells[qty]) || 0;
    out.set(cells[ref], r);
  }
  return out;
}
