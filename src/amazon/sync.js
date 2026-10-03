/**
 * Daily Amazon sync: shipment status, units shipped and received, and links
 * to orders. Replaces typing "6. Shipped" and "9. Closed" into the sheet.
 *
 * Each run: read every open shipment plus anything updated since the last run,
 * merge Amazon's view into the records (keeping links made by hand), then
 * queue WhatsApp cards for what a person should know about.
 */
import { loadLedger, saveLedger } from '../landing/store.js';
import { computeLandingCosts } from '../landing/engine.js';
import { D, sum } from '../landing/money.js';
import { enqueue } from '../notify/outbox.js';
import { shipmentClosedCard, linkRequestCard, shortfallCard } from '../notify/cards.js';
import { queueCostChanges } from '../notify/costs.js';

const DONE = new Set(['CLOSED', 'CANCELLED', 'DELETED']);
const RECEIVING = new Set(['RECEIVING', 'CLOSED']);
const PO_IN_NAME = /\bPO-\d{1,5}\b/i;
// A shortfall worth a card: at least this many units and this share of the line.
const SHORTFALL_UNITS = 5;
const SHORTFALL_SHARE = D('0.01');

export async function syncAmazon({ db, client, now = new Date(), actor = 'amazon-sync', lookbackDays = 90 }) {
  const ledger = loadLedger(db);
  const before = computeLandingCosts(ledger);
  const today = now.toISOString().slice(0, 10);
  const lastRun = db.prepare("SELECT at FROM sync_runs WHERE kind = 'amazon' AND ok = 1 ORDER BY id DESC LIMIT 1").get()?.at;
  const since = new Date(lastRun ? Date.parse(lastRun) - 2 * 86400_000 : now.getTime() - lookbackDays * 86400_000);
  // Amazon rejects a window ending in the future; stay a couple of minutes behind.
  const until = new Date(now.getTime() - 2 * 60_000);

  const report = { checked: 0, updated: [], created: [], linked: [], unmapped: [], cards: 0, errors: [] };
  const changed = [];
  const events = [];
  const unmappedByShipment = new Map();

  for (const marketplace of client.marketplaces()) {
    try {
      const open = ledger.shipments.filter((s) => s.marketplace === marketplace && !DONE.has(s.status)).map((s) => s.id);
      const found = new Map();
      if (open.length) for (const s of await client.getShipments(marketplace, { ids: open })) found.set(s.ShipmentId, s);
      for (const s of await client.getShipments(marketplace, { updatedAfter: since.toISOString(), updatedBefore: until.toISOString() })) found.set(s.ShipmentId, s);

      for (const amazon of found.values()) {
        report.checked++;
        const existing = ledger.shipments.find((x) => x.id === amazon.ShipmentId);
        if (existing && existing.marketplace !== marketplace) continue;
        if (existing && DONE.has(existing.status) && existing.status === amazon.ShipmentStatus) continue;
        const items = await client.getShipmentItems(marketplace, amazon.ShipmentId);
        const merged = mergeShipment({ existing, amazon, items, marketplace, ledger, today });
        changed.push(merged.shipment);
        events.push(...merged.events);
        unmappedByShipment.set(merged.shipment.id, merged.unmapped);
        (existing ? report.updated : report.created).push(merged.shipment.id);
        if (merged.events.some((e) => e.type === 'linked_by_name')) report.linked.push(merged.shipment.id);
        report.unmapped.push(...merged.unmapped.map((u) => `${merged.shipment.id} ${u.sku}`));
      }
    } catch (err) {
      report.errors.push(`${marketplace}: ${err.message}`);
    }
  }

  if (changed.length) saveLedger(db, { shipments: changed }, { actor });
  const saveUnmapped = db.transaction(() => {
    for (const [shipmentId, rows] of unmappedByShipment) {
      db.prepare('DELETE FROM amazon_unmapped WHERE shipment_id = ?').run(shipmentId);
      const ins = db.prepare('INSERT INTO amazon_unmapped (shipment_id, marketplace, sku, fnsku, shipped, received, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const u of rows) ins.run(shipmentId, u.marketplace, u.sku, u.fnsku, u.shipped, u.received, today);
    }
  });
  saveUnmapped();

  const after = computeLandingCosts(loadLedger(db));
  report.cards += queueEventCards(db, events, before, after, loadLedger(db));
  // Shipments that just closed already explain their cost change on the closed card.
  const explained = new Set(events.filter((e) => e.type === 'closed').map((e) => e.shipment));
  report.cards += queueCostChanges(db, after, { skipShipments: explained, reason: 'After the Amazon sync.' });

  db.prepare("INSERT INTO sync_runs (kind, at, ok, summary) VALUES ('amazon', ?, ?, ?)").run(now.toISOString(), report.errors.length ? 0 : 1, JSON.stringify(report));
  return report;
}

/**
 * Amazon's view of one shipment merged into ours. Links to orders made by
 * hand are kept; a PO number in the shipment name links what isn't linked yet.
 */
export function mergeShipment({ existing, amazon, items, marketplace, ledger, today }) {
  const products = ledger.products.filter((p) => p.marketplace === marketplace);
  const findProduct = (item) =>
    products.find((p) => p.sku && p.sku === item.SellerSKU) ||
    products.find((p) => p.fnsku && p.fnsku === item.FulfillmentNetworkSKU) ||
    products.find((p) => (p.aliases || []).includes(item.SellerSKU));

  const byProduct = new Map();
  const unmapped = [];
  for (const it of items) {
    const p = findProduct(it);
    if (!p) {
      unmapped.push({ marketplace, sku: it.SellerSKU, fnsku: it.FulfillmentNetworkSKU || null, shipped: String(it.QuantityShipped ?? 0), received: String(it.QuantityReceived ?? 0) });
      continue;
    }
    const g = byProduct.get(p.id) || { shipped: D(0), received: D(0) };
    g.shipped = g.shipped.plus(D(it.QuantityShipped ?? 0));
    g.received = g.received.plus(D(it.QuantityReceived ?? 0));
    byProduct.set(p.id, g);
  }

  const events = [];
  const oldItems = existing?.items || [];
  const newItems = [];
  for (const [product, g] of byProduct) {
    const mine = oldItems.filter((i) => i.product === product);
    if (mine.length <= 1) {
      newItems.push(clean({ product, po: mine[0]?.po, shipped: g.shipped.toString(), received: g.received.toString() }));
    } else {
      // Split across two orders by hand: keep the split, and say the counts need splitting too.
      newItems.push(...mine);
      if (!sum(mine.map((i) => D(i.shipped))).eq(g.shipped)) events.push({ type: 'split_mismatch', shipment: amazon.ShipmentId, product });
    }
  }
  // Lines entered by hand that Amazon doesn't list (e.g. an unmapped SKU) are kept.
  for (const i of oldItems) if (!byProduct.has(i.product)) newItems.push(i);

  const status = amazon.ShipmentStatus;
  const received = sum(newItems.map((i) => D(i.received)));
  const shipment = clean({
    ...existing,
    id: amazon.ShipmentId,
    marketplace,
    name: amazon.ShipmentName || existing?.name,
    status,
    createdAt: existing?.createdAt || today,
    firstReceivedAt: existing?.firstReceivedAt || (received.gt(0) || RECEIVING.has(status) ? today : undefined),
    syncedAt: today,
  });
  shipment.items = newItems;

  if (!existing) events.push({ type: 'created', shipment: shipment.id });
  if (existing && existing.status !== status && status === 'CLOSED') events.push({ type: 'closed', shipment: shipment.id });
  if (!existing && status === 'CLOSED') events.push({ type: 'closed', shipment: shipment.id });

  // PO number in the name ("PO-041 US") links whatever isn't linked yet.
  const po = (shipment.name || '').match(PO_IN_NAME)?.[0]?.toUpperCase();
  if (po) {
    const order = ledger.orders.find((o) => o.po === po && o.marketplace === marketplace);
    const onOrder = new Set((order?.invoices || []).flatMap((inv) => inv.lines.filter((l) => l.kind === 'goods').map((l) => l.product)));
    let linked = false;
    for (const i of shipment.items) {
      if (!i.po && order && onOrder.has(i.product)) {
        i.po = po;
        linked = true;
      }
    }
    if (linked) events.push({ type: 'linked_by_name', shipment: shipment.id, po });
    if (!order) events.push({ type: 'name_po_unknown', shipment: shipment.id, po });
  }
  if (shipment.items.some((i) => !i.po)) events.push({ type: 'needs_link', shipment: shipment.id });

  return { shipment, events, unmapped };
}

/* ---------------------------- cards ---------------------------- */

function queueEventCards(db, events, before, after, ledger) {
  let queued = 0;
  const q = (card) => {
    if (enqueue(db, card)) queued++;
  };
  const code = (id) => ledger.products.find((p) => p.id === id)?.code || id;

  for (const e of events) {
    const shipment = ledger.shipments.find((s) => s.id === e.shipment);
    if (!shipment) continue;

    if (e.type === 'closed') {
      const lines = after.batches
        .filter((b) => b.shipment === shipment.id)
        .map((b) => {
          const was = before.batches.find((x) => x.shipment === b.shipment && x.product === b.product);
          return { code: code(b.product), shipped: b.shipped, received: b.received ?? b.units, productBefore: was?.productCost ?? null, productAfter: b.productCost, landing: b.landingCost, status: b.status, currency: b.currency };
        });
      q({ kind: 'shipment_closed', dedupeKey: `closed:${shipment.id}`, text: shipmentClosedCard({ shipment: shipment.id, marketplace: shipment.marketplace, lines }) });

      for (const b of after.batches.filter((x) => x.shipment === shipment.id && x.received !== null)) {
        const short = b.shipped.minus(b.received);
        if (short.gte(SHORTFALL_UNITS) && short.div(b.shipped).gte(SHORTFALL_SHARE)) {
          q({
            kind: 'shortfall',
            dedupeKey: `shortfall:${shipment.id}:${b.product}`,
            text: shortfallCard({ shipment: shipment.id, marketplace: shipment.marketplace, code: code(b.product), shipped: b.shipped, received: b.received, valueAtCost: b.productCost ? b.productCost.times(short) : null, currency: b.currency }),
          });
        }
      }
    }

    if (e.type === 'needs_link') {
      const unlinked = shipment.items.filter((i) => !i.po);
      const candidate = suggestOrder(ledger, shipment, unlinked);
      q({
        kind: 'link_request',
        dedupeKey: `link:${shipment.id}`,
        needsReply: Boolean(candidate),
        payload: candidate ? { action: 'link', shipment: shipment.id, marketplace: shipment.marketplace, po: candidate.po, products: unlinked.map((i) => i.product) } : null,
        text: linkRequestCard({
          shipment: shipment.id,
          marketplace: shipment.marketplace,
          lines: unlinked.map((i) => ({ qty: i.shipped, name: ledger.products.find((p) => p.id === i.product)?.name || i.product })),
          candidate,
        }),
      });
    }
  }
  return queued;
}

/**
 * The one open order that could have sent every unlinked line, if exactly one
 * fits. Never guesses between two.
 */
export function suggestOrder(ledger, shipment, unlinked) {
  const candidates = ledger.orders.filter((o) => o.marketplace === shipment.marketplace).map((o) => {
    const inv = [...(o.invoices || [])].sort((a, b) => (a.kind === b.kind ? String(a.date).localeCompare(String(b.date)) : a.kind === 'final' ? 1 : -1)).pop();
    let open = D(0);
    const fits = unlinked.every((item) => {
      const ordered = sum((inv?.lines || []).filter((l) => l.kind === 'goods' && l.product === item.product).map((l) => D(l.qty)));
      const sent = sum(ledger.shipments.filter((s) => s.id !== shipment.id).flatMap((s) => s.items.filter((i) => i.po === o.po && i.product === item.product)).map((i) => D(i.shipped)));
      const writtenOff = sum((o.writeOffs || []).filter((w) => w.product === item.product).map((w) => D(w.qty)));
      const remaining = ordered.minus(sent).minus(writtenOff);
      open = open.plus(remaining);
      // Allow a few percent over: supplier counts and Amazon counts differ.
      return ordered.gt(0) && remaining.times('1.05').gte(D(item.shipped));
    });
    return fits ? { po: o.po, supplier: o.supplier, open } : null;
  }).filter(Boolean);
  return candidates.length === 1 ? candidates[0] : null;
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}
