// Re-running an import never undoes work done since. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { importLedger } from '../../src/landing/importer.js';

const file = (overrides = {}) => ({
  ledger: {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [
      { po: 'PO-1', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 }] }] },
      { po: 'PO-2', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i2', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 50, rmb: 500 }] }] },
      { po: 'PO-3', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i3', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }] },
    ],
    payments: [
      { id: 'P1', date: '2026-01-01', gbp: 100, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] },
      { id: 'P2', date: '2026-01-02', gbp: 50, allocations: [{ type: 'order', target: 'PO-2', part: 'full' }] },
    ],
    courierBills: [],
    shipments: [{ id: 'FBA1', marketplace: 'UK', status: 'SHIPPED', items: [{ product: 'A-UK', po: 'PO-1', shipped: 100 }] }],
    ...overrides,
  },
});

test('a second import replaces only what nobody has touched since', () => {
  const db = openLandingDb(':memory:');
  const first = importLedger(db, file());
  assert.deepEqual(first.added.orders, ['PO-1', 'PO-2', 'PO-3']);

  // Since then: Amazon updated the shipment, Atif fixed a payment, Ashar checked PO-2.
  const l = loadLedger(db);
  saveLedger(db, { shipments: [{ ...l.shipments[0], status: 'CLOSED', items: [{ ...l.shipments[0].items[0], received: 98 }] }] }, { actor: 'amazon-sync' });
  saveLedger(db, { payments: [{ ...l.payments[0], gbp: '101' }] }, { actor: 'Atif' });
  saveLedger(db, { orders: [{ ...l.orders.find((o) => o.po === 'PO-2'), review: 'reviewed' }] }, { actor: 'Ashar' });

  // The sheet is re-imported with stale values everywhere, plus a new order.
  const changed = file();
  changed.ledger.shipments[0].status = 'WORKING';
  changed.ledger.payments[0].gbp = 99;
  changed.ledger.orders[1].supplier = 'Stale';
  changed.ledger.orders[2].supplier = 'Corrected'; // PO-3 untouched: the correction should land
  changed.ledger.orders.push({ po: 'PO-4', supplier: 'New', marketplace: 'UK', invoices: [{ id: 'i4', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 1, rmb: 1 }] }] });
  const second = importLedger(db, changed);

  const after = loadLedger(db);
  assert.equal(after.shipments[0].status, 'CLOSED');
  assert.equal(after.shipments[0].items[0].received, '98');
  assert.equal(after.payments.find((p) => p.id === 'P1').gbp, '101');
  assert.equal(after.orders.find((o) => o.po === 'PO-2').supplier, 'S');
  assert.equal(after.orders.find((o) => o.po === 'PO-2').review, 'reviewed');
  assert.equal(after.orders.find((o) => o.po === 'PO-3').supplier, 'Corrected');
  assert.deepEqual(second.added.orders, ['PO-4']);
  assert.deepEqual(second.kept.shipments, ['FBA1']);
  assert.deepEqual(second.kept.payments, ['P1']);
  assert.deepEqual(second.replaced.payments, ['P2']);
});

test('--force overwrites everything, on purpose', () => {
  const db = openLandingDb(':memory:');
  importLedger(db, file());
  const l = loadLedger(db);
  saveLedger(db, { payments: [{ ...l.payments[0], gbp: '101' }] }, { actor: 'Atif' });
  importLedger(db, file(), { force: true });
  assert.equal(loadLedger(db).payments.find((p) => p.id === 'P1').gbp, '100');
});
