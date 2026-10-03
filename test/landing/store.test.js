import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { computeLandingCosts } from '../../src/landing/engine.js';
import { fmt4 } from '../../src/landing/money.js';

const ledger = {
  products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', aliases: ['A 10pcs/pack'] }],
  orders: [{
    po: 'PO-1', supplier: 'Test Supplier', marketplace: 'UK',
    invoices: [{ id: 'INV-1', kind: 'final', date: '2026-01-10', statedTotalRmb: '1,000.50', lines: [{ kind: 'goods', product: 'A-UK', qty: 3, rmb: '1000.50' }] }],
  }],
  payments: [{ id: 'P1', date: '2026-01-15', gbp: '100.01', allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }],
  courierBills: [],
  shipments: [{ id: 'FBA1', marketplace: 'UK', status: 'SHIPPED', createdAt: '2026-02-01', items: [{ product: 'A-UK', po: 'PO-1', shipped: 3 }] }],
};

test('a ledger survives the database exactly, and re-importing replaces rather than duplicates', () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, ledger, { actor: 'test' });
  saveLedger(db, ledger, { actor: 'test' });
  const loaded = loadLedger(db);

  assert.equal(loaded.orders[0].invoices.length, 1);
  assert.equal(loaded.orders[0].invoices[0].lines.length, 1);
  assert.equal(loaded.payments[0].allocations.length, 1);
  assert.equal(loaded.orders[0].invoices[0].statedTotalRmb, '1000.5'); // exact text, commas stripped
  assert.deepEqual(loaded.products[0].aliases, ['A 10pcs/pack']);

  const before = computeLandingCosts(ledger);
  const after = computeLandingCosts(loaded);
  assert.equal(fmt4(after.batches[0].productCost), fmt4(before.batches[0].productCost));
  assert.equal(fmt4(after.batches[0].productCost), '33.3367'); // 100.01 / 3, no float drift

  const audit = db.prepare('SELECT actor, entity FROM audit_log').all();
  assert.ok(audit.length > 0 && audit.every((a) => a.actor === 'test'));
});

test('a shipment item cannot point at an order that does not exist', () => {
  const db = openLandingDb(':memory:');
  const bad = structuredClone(ledger);
  bad.shipments[0].items[0].po = 'PO-404';
  assert.throws(() => saveLedger(db, bad), /FOREIGN KEY/);
});
