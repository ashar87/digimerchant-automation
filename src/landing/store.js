/**
 * Landing-cost records in SQLite.
 *
 * Only source records are stored: invoices, payments, courier bills,
 * shipments. Costs are never stored; the engine recomputes them on demand.
 * Amounts are TEXT so they stay exact (REAL would bring floating point back).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { toText } from './money.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,           -- e.g. EGLS10-UK
  code        TEXT NOT NULL,              -- internal code, e.g. EGLS10
  marketplace TEXT NOT NULL CHECK (marketplace IN ('UK','DE','US')),
  name        TEXT,
  sku         TEXT,
  asin        TEXT,
  fnsku       TEXT,
  aliases     TEXT                        -- JSON array: names suppliers and old tabs use
);

CREATE TABLE IF NOT EXISTS orders (
  po          TEXT PRIMARY KEY,           -- e.g. PO-041; mandatory, written into Wise refs and shipment names
  supplier    TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('UK','DE','US')),
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id               TEXT PRIMARY KEY,
  po               TEXT NOT NULL REFERENCES orders(po),
  kind             TEXT NOT NULL CHECK (kind IN ('proforma','final')),
  date             TEXT,                  -- ISO yyyy-mm-dd
  supplier_ref     TEXT,
  stated_total_rmb TEXT,
  file_path        TEXT
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id          INTEGER PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('goods','labour','fee','adjustment','expense')),
  product     TEXT REFERENCES products(id),
  qty         TEXT,
  rmb         TEXT,
  description TEXT,
  category    TEXT                        -- for expenses: Advertising, R&D, ...
);

CREATE TABLE IF NOT EXISTS write_offs (
  id      INTEGER PRIMARY KEY,
  po      TEXT NOT NULL REFERENCES orders(po),
  product TEXT NOT NULL REFERENCES products(id),
  qty     TEXT NOT NULL,
  reason  TEXT,
  date    TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id        TEXT PRIMARY KEY,
  date      TEXT NOT NULL,
  reference TEXT,                         -- the Wise reference, e.g. "PO-041 30%"
  usd       TEXT,                         -- USD sent to the supplier
  gbp       TEXT,                         -- GBP actually paid, when funded in GBP
  eur       TEXT,
  qb_rate   TEXT,                         -- GBP per USD (or per EUR) on the payment date
  fee       TEXT,                         -- Wise fee: an expense, never landing cost
  funding   TEXT,
  notes     TEXT
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id          INTEGER PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('order','bill','expense','credit','other')),
  target      TEXT,                       -- PO, bill id, expense category, agent
  part        TEXT CHECK (part IN ('deposit','balance','full') OR part IS NULL),
  usd         TEXT,                       -- the USD this invoice states
  rmb         TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS courier_bills (
  id               TEXT PRIMARY KEY,
  agent            TEXT,
  date             TEXT,
  stated_total_rmb TEXT,
  rmb_per_usd      TEXT,
  file_path        TEXT
);

CREATE TABLE IF NOT EXISTS courier_bill_lines (
  id          INTEGER PRIMARY KEY,
  bill_id     TEXT NOT NULL REFERENCES courier_bills(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('shipping','domestic','fee','adjustment','expense')),
  shipment    TEXT,                       -- FBA ID as printed on the bill
  rmb         TEXT NOT NULL,
  description TEXT,
  category    TEXT
);

CREATE TABLE IF NOT EXISTS shipments (
  id                TEXT PRIMARY KEY,     -- FBA shipment ID
  marketplace       TEXT NOT NULL CHECK (marketplace IN ('UK','DE','US')),
  name              TEXT,
  status            TEXT,                 -- SP-API ShipmentStatus
  created_at        TEXT,
  first_received_at TEXT,                 -- Sellerboard batch date
  synced_at         TEXT
);

CREATE TABLE IF NOT EXISTS shipment_items (
  id          INTEGER PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  product     TEXT NOT NULL REFERENCES products(id),
  po          TEXT REFERENCES orders(po),
  shipped     TEXT NOT NULL,
  received    TEXT
);

-- Both owners edit; every change records who and when.
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data      TEXT
);
`;

export function openLandingDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const t = (v) => (v === undefined ? null : toText(v));
const s = (v) => (v === undefined || v === null ? null : String(v));

/**
 * Writes a whole ledger (as the engine reads it) in one transaction. Each
 * record replaces any existing one with the same id, so re-importing is safe.
 */
export function saveLedger(db, ledger, { actor = 'import' } = {}) {
  const at = new Date().toISOString();
  const audit = db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)');
  const log = (entity, id, data) => audit.run(at, actor, 'upsert', entity, id, json(data));

  const run = db.transaction(() => {
    const product = db.prepare(`INSERT INTO products (id, code, marketplace, name, sku, asin, fnsku, aliases) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET code = excluded.code, marketplace = excluded.marketplace, name = excluded.name, sku = excluded.sku, asin = excluded.asin, fnsku = excluded.fnsku, aliases = excluded.aliases`);
    for (const p of ledger.products || []) {
      product.run(p.id, p.code, p.marketplace, s(p.name), s(p.sku), s(p.asin), s(p.fnsku), json(p.aliases));
      log('product', p.id, p);
    }

    const order = db.prepare(`INSERT INTO orders (po, supplier, marketplace, notes) VALUES (?, ?, ?, ?) ON CONFLICT(po) DO UPDATE SET supplier = excluded.supplier, marketplace = excluded.marketplace, notes = excluded.notes`);
    const clearInvoices = db.prepare('DELETE FROM invoices WHERE po = ?');
    const invoice = db.prepare('INSERT INTO invoices (id, po, kind, date, supplier_ref, stated_total_rmb, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const line = db.prepare('INSERT INTO invoice_lines (invoice_id, seq, kind, product, qty, rmb, description, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const clearWriteOffs = db.prepare('DELETE FROM write_offs WHERE po = ?');
    const writeOff = db.prepare('INSERT INTO write_offs (po, product, qty, reason, date) VALUES (?, ?, ?, ?, ?)');
    for (const o of ledger.orders || []) {
      order.run(o.po, o.supplier, o.marketplace, s(o.notes));
      clearInvoices.run(o.po);
      for (const inv of o.invoices || []) {
        invoice.run(inv.id, o.po, inv.kind, s(inv.date), s(inv.supplierRef), t(inv.statedTotalRmb), s(inv.filePath));
        (inv.lines || []).forEach((l, i) => line.run(inv.id, i, l.kind, s(l.product), t(l.qty), t(l.rmb), s(l.description), s(l.category)));
      }
      clearWriteOffs.run(o.po);
      for (const w of o.writeOffs || []) writeOff.run(o.po, w.product, t(w.qty), s(w.reason), s(w.date));
      log('order', o.po, o);
    }

    const bill = db.prepare(`INSERT INTO courier_bills (id, agent, date, stated_total_rmb, rmb_per_usd, file_path) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, date = excluded.date, stated_total_rmb = excluded.stated_total_rmb, rmb_per_usd = excluded.rmb_per_usd, file_path = excluded.file_path`);
    const clearBillLines = db.prepare('DELETE FROM courier_bill_lines WHERE bill_id = ?');
    const billLine = db.prepare('INSERT INTO courier_bill_lines (bill_id, seq, kind, shipment, rmb, description, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const b of ledger.courierBills || []) {
      bill.run(b.id, s(b.agent), s(b.date), t(b.statedTotalRmb), t(b.rmbPerUsd), s(b.filePath));
      clearBillLines.run(b.id);
      (b.lines || []).forEach((l, i) => billLine.run(b.id, i, l.kind, s(l.shipment), t(l.rmb), s(l.description), s(l.category)));
      log('courier_bill', b.id, b);
    }

    const shipment = db.prepare(`INSERT INTO shipments (id, marketplace, name, status, created_at, first_received_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET marketplace = excluded.marketplace, name = excluded.name, status = excluded.status, created_at = excluded.created_at, first_received_at = excluded.first_received_at, synced_at = excluded.synced_at`);
    const clearItems = db.prepare('DELETE FROM shipment_items WHERE shipment_id = ?');
    const item = db.prepare('INSERT INTO shipment_items (shipment_id, product, po, shipped, received) VALUES (?, ?, ?, ?, ?)');
    for (const sh of ledger.shipments || []) {
      shipment.run(sh.id, sh.marketplace, s(sh.name), s(sh.status), s(sh.createdAt), s(sh.firstReceivedAt), s(sh.syncedAt));
      clearItems.run(sh.id);
      for (const it of sh.items || []) item.run(sh.id, it.product, s(it.po), t(it.shipped), t(it.received));
      log('shipment', sh.id, sh);
    }

    // Payments last: their allocations point at orders and bills.
    const payment = db.prepare(`INSERT INTO payments (id, date, reference, usd, gbp, eur, qb_rate, fee, funding, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, reference = excluded.reference, usd = excluded.usd, gbp = excluded.gbp, eur = excluded.eur, qb_rate = excluded.qb_rate, fee = excluded.fee, funding = excluded.funding, notes = excluded.notes`);
    const clearAllocations = db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?');
    const allocation = db.prepare('INSERT INTO payment_allocations (payment_id, seq, type, target, part, usd, rmb, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of ledger.payments || []) {
      payment.run(p.id, p.date, s(p.reference), t(p.usd), t(p.gbp), t(p.eur), t(p.qbRate), t(p.fee), s(p.funding), s(p.notes));
      clearAllocations.run(p.id);
      (p.allocations || []).forEach((a, i) => allocation.run(p.id, i, a.type, s(a.target), s(a.part), t(a.usd), t(a.rmb), s(a.description)));
      log('payment', p.id, p);
    }
  });
  run();
}

/** Reads everything back in the shape computeLandingCosts expects. */
export function loadLedger(db) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

  const products = all('SELECT * FROM products ORDER BY id').map((p) => strip({ ...p, aliases: p.aliases ? JSON.parse(p.aliases) : null }));

  const linesByInvoice = groupBy(all('SELECT * FROM invoice_lines ORDER BY invoice_id, seq'), 'invoice_id');
  const invoicesByPo = groupBy(all('SELECT * FROM invoices ORDER BY date, id'), 'po');
  const writeOffsByPo = groupBy(all('SELECT * FROM write_offs ORDER BY id'), 'po');
  const orders = all('SELECT * FROM orders ORDER BY po').map((o) =>
    strip({
      ...o,
      invoices: (invoicesByPo.get(o.po) || []).map((i) =>
        strip({
          id: i.id,
          kind: i.kind,
          date: i.date,
          supplierRef: i.supplier_ref,
          statedTotalRmb: i.stated_total_rmb,
          filePath: i.file_path,
          lines: (linesByInvoice.get(i.id) || []).map((l) => strip({ kind: l.kind, product: l.product, qty: l.qty, rmb: l.rmb, description: l.description, category: l.category })),
        })
      ),
      writeOffs: (writeOffsByPo.get(o.po) || []).map((w) => strip({ product: w.product, qty: w.qty, reason: w.reason, date: w.date })),
    })
  );

  const allocationsByPayment = groupBy(all('SELECT * FROM payment_allocations ORDER BY payment_id, seq'), 'payment_id');
  const payments = all('SELECT * FROM payments ORDER BY date, id').map((p) =>
    strip({
      id: p.id,
      date: p.date,
      reference: p.reference,
      usd: p.usd,
      gbp: p.gbp,
      eur: p.eur,
      qbRate: p.qb_rate,
      fee: p.fee,
      funding: p.funding,
      notes: p.notes,
      allocations: (allocationsByPayment.get(p.id) || []).map((a) => strip({ type: a.type, target: a.target, part: a.part, usd: a.usd, rmb: a.rmb, description: a.description })),
    })
  );

  const billLines = groupBy(all('SELECT * FROM courier_bill_lines ORDER BY bill_id, seq'), 'bill_id');
  const courierBills = all('SELECT * FROM courier_bills ORDER BY date, id').map((b) =>
    strip({
      id: b.id,
      agent: b.agent,
      date: b.date,
      statedTotalRmb: b.stated_total_rmb,
      rmbPerUsd: b.rmb_per_usd,
      filePath: b.file_path,
      lines: (billLines.get(b.id) || []).map((l) => strip({ kind: l.kind, shipment: l.shipment, rmb: l.rmb, description: l.description, category: l.category })),
    })
  );

  const itemsByShipment = groupBy(all('SELECT * FROM shipment_items ORDER BY shipment_id, id'), 'shipment_id');
  const shipments = all('SELECT * FROM shipments ORDER BY created_at, id').map((sh) =>
    strip({
      id: sh.id,
      marketplace: sh.marketplace,
      name: sh.name,
      status: sh.status,
      createdAt: sh.created_at,
      firstReceivedAt: sh.first_received_at,
      syncedAt: sh.synced_at,
      items: (itemsByShipment.get(sh.id) || []).map((i) => strip({ product: i.product, po: i.po, shipped: i.shipped, received: i.received })),
    })
  );

  return { products, orders, payments, courierBills, shipments };
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
}
