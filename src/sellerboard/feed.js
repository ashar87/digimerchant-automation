/**
 * The Sellerboard cost feed: one row per product per shipment, read daily by
 * Sellerboard's automatic COGS import (Settings → Automation) from a Google
 * Sheet or a CSV link. FIFO, so each shipment's stock sells at its own cost.
 *
 * GBP for the UK and DE (Sellerboard wants GBP for DE too), USD for the US.
 * The batch date is the day Amazon started receiving the shipment.
 *
 * Column headers must match Sellerboard's COGS template. They're defined once
 * here: if Sellerboard's template names them differently, change COLUMNS.
 */
import { fmt4 } from '../landing/money.js';

export const COLUMNS = [
  { key: 'sku', header: 'SKU' },
  { key: 'asin', header: 'ASIN' },
  { key: 'marketplace', header: 'Marketplace' },
  { key: 'date', header: 'Date' },
  { key: 'quantity', header: 'Batch quantity' },
  { key: 'cost', header: 'Cost per unit' },
  { key: 'currency', header: 'Currency' },
  { key: 'shipment', header: 'Batch' },
  { key: 'status', header: 'Status' },
];

const MARKETPLACE_NAMES = { UK: 'Amazon.co.uk', DE: 'Amazon.de', US: 'Amazon.com' };
const STATUS_WORDS = { final: 'final', count_pending: 'awaiting Amazon count', estimated: 'delivery estimated' };

/**
 * Splits batches into what Sellerboard gets and what's held back, with the
 * reason for each one held.
 */
export function buildFeed(ledger, result) {
  const shipments = new Map(ledger.shipments.map((s) => [s.id, s]));
  const products = new Map(ledger.products.map((p) => [p.id, p]));
  const orders = new Map(ledger.orders.map((o) => [o.po, o]));
  const rows = [];
  const held = [];

  for (const b of result.batches) {
    const s = shipments.get(b.shipment);
    const p = products.get(b.product);
    const hold = (reason) => held.push({ shipment: b.shipment, product: b.product, code: b.code, marketplace: b.marketplace, reason });

    if (s?.sellerboardManual) {
      hold('Typed into Sellerboard by hand; the feed leaves it alone.');
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
      date: s.firstReceivedAt || s.createdAt || '',
      dateProvisional: !s.firstReceivedAt,
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
