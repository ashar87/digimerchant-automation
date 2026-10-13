/**
 * The Sellerboard cost feed: one row per product per shipment, read daily by
 * Sellerboard's automatic COGS import (Settings → Automation) from a Google
 * Sheet or a CSV link. FIFO, so each shipment's stock sells at its own cost.
 *
 * GBP for the UK and DE (Sellerboard wants GBP for DE too), USD for the US.
 * A batch only goes in once Amazon starts receiving it, dated that day: that's
 * when the stock becomes sellable and the inventory level starts to rise.
 *
 * Columns, names and order as in Sellerboard's own product export (Products →
 * Export, checked 13 Oct 2026), with dates day/month/year as it writes them, so
 * the file imports without remapping. The dashboard page shows a few more
 * (currency, shipment, status) that stay out of the file.
 */
import { fmt4 } from '../landing/money.js';

export const COLUMNS = [
  { key: 'asin', header: 'ASIN' },
  { key: 'sku', header: 'SKU' },
  { key: 'startDate', header: 'CostPeriodStartDate' },
  { key: 'cost', header: 'Cost' },
  { key: 'marketplace', header: 'Marketplace' },
  { key: 'quantity', header: 'BatchQuantity' },
];
export const PAGE_COLUMNS = [...COLUMNS, { key: 'currency', header: 'Currency' }, { key: 'shipment', header: 'Shipment' }, { key: 'status', header: 'Status' }];

const dayMonthYear = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const MARKETPLACE_NAMES = { UK: 'Amazon.co.uk', DE: 'Amazon.de', US: 'Amazon.com' };
const STATUS_WORDS = { final: 'final', count_pending: 'awaiting Amazon count', estimated: 'delivery estimated' };

/**
 * Splits batches into what Sellerboard gets and what's held back, with the
 * reason for each one held.
 */
export function buildFeed(ledger, result, { includeManual = false, shipment = null } = {}) {
  const shipments = new Map(ledger.shipments.map((s) => [s.id, s]));
  const products = new Map(ledger.products.map((p) => [p.id, p]));
  const orders = new Map(ledger.orders.map((o) => [o.po, o]));
  const rows = [];
  const held = [];

  for (const b of result.batches) {
    if (shipment && b.shipment !== shipment) continue;
    const s = shipments.get(b.shipment);
    const p = products.get(b.product);
    const hold = (reason) => held.push({ shipment: b.shipment, product: b.product, code: b.code, marketplace: b.marketplace, reason });

    if (s?.sellerboardManual && !includeManual) {
      hold('Typed into Sellerboard by hand; the feed leaves it alone.');
      continue;
    }
    if (!s?.firstReceivedAt) {
      const arrived = ['RECEIVING', 'CLOSED'].includes(s?.status);
      hold(arrived ? 'Amazon is receiving it, but the date it started isn’t recorded. Enter it on the shipment.' : 'Not received yet: added the day Amazon starts receiving it.');
      continue;
    }
    if (b.landingCost === null || b.status === 'incomplete') {
      hold('Cost not known yet.');
      continue;
    }
    if (b.status === 'provisional') {
      hold('Only the deposit is paid.');
      continue;
    }
    const unchecked = b.orders.filter((po) => orders.get(po)?.review === 'needs_review');
    if (unchecked.length) {
      hold(`Imported order ${unchecked.join(', ')} not checked yet.`);
      continue;
    }
    if (!p?.sku && !p?.asin) {
      hold(`${b.product} has no SKU or ASIN in the product list.`);
      continue;
    }
    rows.push({
      sku: p.sku || '',
      asin: p.asin || '',
      marketplace: MARKETPLACE_NAMES[b.marketplace],
      date: s.firstReceivedAt,
      startDate: dayMonthYear(s.firstReceivedAt),
      quantity: b.units.toString(),
      cost: fmt4(b.landingCost),
      currency: b.currency,
      shipment: b.shipment,
      status: STATUS_WORDS[b.status] || b.status,
      product: b.product,
    });
  }
  rows.sort((a, b) => a.marketplace.localeCompare(b.marketplace) || (a.sku || a.asin).localeCompare(b.sku || b.asin) || a.date.localeCompare(b.date));
  return { rows, held };
}

export function feedValues(rows) {
  return [COLUMNS.map((c) => c.header), ...rows.map((r) => COLUMNS.map((c) => r[c.key] ?? ''))];
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    // Quote anything with a separator, and defuse spreadsheet formulas.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return feedValues(rows).map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
