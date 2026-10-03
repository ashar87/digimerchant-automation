import { notFound } from '../errors.js';

export const MARKETPLACES = ['UK', 'DE', 'US'];

/** Where an engine issue's ref lives in the dashboard. */
export function refHref(ledger, ref) {
  if (!ref) return null;
  if (ledger.orders.some((o) => o.po === ref)) return `/orders/${encodeURIComponent(ref)}`;
  if (ledger.payments.some((p) => p.id === ref)) return `/payments/${encodeURIComponent(ref)}`;
  if (ledger.shipments.some((s) => s.id === ref)) return `/shipments/${encodeURIComponent(ref)}`;
  if (ledger.courierBills.some((b) => b.id === ref)) return `/bills/${encodeURIComponent(ref)}`;
  return null;
}

export function productOptions(ledger, marketplace) {
  return ledger.products
    .filter((p) => !marketplace || p.marketplace === marketplace)
    .map((p) => ({ value: p.id, label: `${p.id}${p.name ? ` · ${p.name}` : ''}` }));
}

export function poOptions(ledger, marketplace) {
  return ledger.orders.filter((o) => !marketplace || o.marketplace === marketplace).map((o) => ({ value: o.po, label: `${o.po} · ${o.supplier}` }));
}

export function findOrder(ctx, po) {
  const order = ctx.data.ledger.orders.find((o) => o.po === po);
  if (!order) throw notFound(`Order ${po}`);
  return order;
}

export const productName = (ledger, id) => {
  const p = ledger.products.find((x) => x.id === id);
  return p ? `${p.code} ${p.marketplace}` : id;
};

export const enc = encodeURIComponent;
