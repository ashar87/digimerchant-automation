/**
 * The Sellerboard cost feed: one row per product per shipment, read daily by
 * Sellerboard's automatic COGS import from a Google Sheet, or uploaded by hand
 * (Products → Import, accounting method by batch). FIFO, so each shipment's
 * stock sells at its own cost.
 *
 * Two Sellerboard accounts, two files: the UK and DE in one, costed in GBP
 * (Sellerboard wants GBP for DE too), and the US in the other, in USD.
 * A batch only goes in once Amazon starts receiving it, dated that day: that's
 * when the stock becomes sellable and the inventory level starts to rise.
 *
 * The file is Sellerboard's own import template: all 17 columns, names and
 * order as its product export writes them, dates day/month/year. Only the batch
 * date, cost, marketplace and quantity are ours; every other column is copied
 * from Sellerboard's own row for that SKU (see catalog.js), so an import can't
 * blank a product's VAT or EAN. Checked on 25 Oct 2026: an import adds the
 * batch beside the others, a second import of the same batch doesn't add it
 * twice, and the cost must have at most 2 decimals ("Wrong format COST").
 */
import ExcelJS from 'exceljs';
import { D, fmt4 } from '../landing/money.js';

export const HEADERS = ['ASIN', 'SKU', 'Title', 'Labels', 'CostPeriodStartDate', 'Cost', 'DomesticShippingCost', 'RestofworldShippingCost', 'ShippingProfile', 'Value_of_unsellable_returns', 'VAT', 'VAT_CATEGORY', 'Hide', 'Marketplace', 'BatchQuantity', 'EAN', 'UPC'];

/** What the dashboard page shows of each row; the file itself has all of HEADERS. */
export const PAGE_COLUMNS = [
  { key: 'sku', header: 'SKU' },
  { key: 'asin', header: 'ASIN' },
  { key: 'startDate', header: 'Batch date' },
  { key: 'cost', header: 'Cost' },
  { key: 'marketplace', header: 'Marketplace' },
  { key: 'quantity', header: 'Units' },
  { key: 'shipment', header: 'Shipment' },
  { key: 'status', header: 'Status' },
];

export const ACCOUNTS = {
  'uk-de': { label: 'UK + DE', currency: 'GBP', marketplaces: ['UK', 'DE'] },
  us: { label: 'US', currency: 'USD', marketplaces: ['US'] },
};
export const accountOf = (marketplace) => Object.keys(ACCOUNTS).find((a) => ACCOUNTS[a].marketplaces.includes(marketplace));

const dayMonthYear = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const MARKETPLACE_NAMES = { UK: 'Amazon.co.uk', DE: 'Amazon.de', US: 'Amazon.com' };
export const MARKETPLACE_CODES = Object.fromEntries(Object.entries(MARKETPLACE_NAMES).map(([k, v]) => [v, k]));
const STATUS_WORDS = { final: 'final', count_pending: 'awaiting Amazon count', estimated: 'delivery estimated' };

/** Sellerboard's own row for this product: its row in this marketplace, else its row with no cost yet. */
function sellerboardRow(rows, marketplace, product) {
  for (const id of [product.sku, product.asin].filter(Boolean)) {
    const hit = rows.get(`${marketplace}|${id}`) || rows.get(`|${id}`) || [...rows.values()].find((v) => v.ASIN === id && v.Marketplace === marketplace);
    if (hit) return hit;
  }
  return null;
}

/**
 * Splits batches into what Sellerboard gets and what's held back, with the
 * reason for each one held. `account` narrows it to one Sellerboard account;
 * `catalog` is Sellerboard's product list per account (loadCatalog).
 */
export function buildFeed(ledger, result, { includeManual = false, shipment = null, account = null, catalog = {} } = {}) {
  const shipments = new Map(ledger.shipments.map((s) => [s.id, s]));
  const products = new Map(ledger.products.map((p) => [p.id, p]));
  const orders = new Map(ledger.orders.map((o) => [o.po, o]));
  const rows = [];
  const held = [];

  for (const b of result.batches) {
    if (shipment && b.shipment !== shipment) continue;
    const acct = accountOf(b.marketplace);
    if (account && acct !== account) continue;
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
    const marketplace = MARKETPLACE_NAMES[b.marketplace];
    if (!catalog[acct]) {
      hold(`Sellerboard’s product list for the ${ACCOUNTS[acct].label} account isn’t uploaded yet (Sellerboard page).`);
      continue;
    }
    const base = sellerboardRow(catalog[acct].rows, marketplace, p);
    if (!base) {
      hold(`${p.sku || p.asin} on ${marketplace} isn’t in Sellerboard’s product list. Check the SKU, or upload a fresh export from Sellerboard.`);
      continue;
    }
    const cost = Number(D(b.landingCost).toFixed(2));
    const values = HEADERS.map((h) => base[h] ?? null);
    const set = (h, v) => (values[HEADERS.indexOf(h)] = v);
    set('ASIN', base.ASIN || p.asin || null);
    set('CostPeriodStartDate', dayMonthYear(s.firstReceivedAt));
    set('Cost', cost);
    set('Marketplace', marketplace);
    set('BatchQuantity', Number(b.units.toString()));
    rows.push({
      sku: base.SKU,
      asin: values[0] || '',
      marketplace,
      date: s.firstReceivedAt,
      startDate: dayMonthYear(s.firstReceivedAt),
      quantity: b.units.toString(),
      cost: cost.toFixed(2),
      exactCost: fmt4(b.landingCost),
      currency: b.currency,
      shipment: b.shipment,
      account: acct,
      status: STATUS_WORDS[b.status] || b.status,
      product: b.product,
      values,
    });
  }
  rows.sort((a, b) => a.marketplace.localeCompare(b.marketplace) || (a.sku || a.asin).localeCompare(b.sku || b.asin) || a.date.localeCompare(b.date));
  return { rows, held };
}

export function feedValues(rows) {
  return [HEADERS, ...rows.map((r) => r.values.map((v) => v ?? ''))];
}

/** The rows as Sellerboard's import template (.xlsx), costs shown to 2 decimals as in its own files. */
export async function toXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TDSheet');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r.values.map((v) => v ?? null));
  ws.getColumn(HEADERS.indexOf('Cost') + 1).numFmt = '0.00';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
