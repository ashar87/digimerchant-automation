// A bill naming a shipment that isn't on the dashboard yet: it's looked up at
// Amazon (a recorded stand-in) and added before the bill is read against the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { recordedSpApi } from '../../src/amazon/recorded.js';
import { intakeBill } from '../../src/bills/intake.js';

test('FBA IDs on a bill that are new to the dashboard are fetched from Amazon and linked to their PO', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-lookup-'));
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-US', code: 'A', marketplace: 'US', sku: 'SKU-A' }],
    orders: [{ po: 'PO-030', supplier: 'S', marketplace: 'US', invoices: [{ id: 'i30', kind: 'proforma', lines: [{ kind: 'goods', product: 'A-US', qty: 100, rmb: 1000 }] }] }],
    shipments: [{ id: 'FBA99OLD0001', marketplace: 'US', status: 'CLOSED', items: [] }],
  }, { actor: 'test' });
  const amazon = recordedSpApi({
    shipments: { US: [{ ShipmentId: 'FBA99NEW0001', ShipmentName: 'PO-030 US', ShipmentStatus: 'SHIPPED' }] },
    items: { FBA99NEW0001: [{ SellerSKU: 'SKU-A', QuantityShipped: 60, QuantityReceived: 0 }] },
  });
  const reader = {
    read: async () => ({
      rows: [
        { fbaId: 'FBA99OLD0001', service: 'USA airline', country: 'USA', amount: 100 },
        { fbaId: 'FBA99NEW0001', service: 'USA airline', country: 'USA', amount: 200 },
        { fbaId: 'FBA99GONE001', service: 'USA airline', country: 'USA', amount: 50 },
      ],
      totalRmb: 350,
      rmbPerUsd: 7,
    }),
  };
  try {
    const draft = await intakeBill({ db, buffer: Buffer.from('fake'), filename: 'bill.jpg', mime: 'image/jpeg', actor: 'Ashar', reader, amazon, dir });
    const s = loadLedger(db).shipments.find((x) => x.id === 'FBA99NEW0001');
    assert.deepEqual(s.items.map((i) => [i.product, i.po, i.shipped]), [['A-US', 'PO-030', '60']]);
    assert.deepEqual(draft.reading.lines.map((l) => l.shipment), ['FBA99OLD0001', 'FBA99NEW0001', 'FBA99GONE001']);
    const say = draft.reading.checks.map((c) => `${c.severity}: ${c.message}`);
    assert.ok(say.includes('ok: FBA99NEW0001 wasn’t on the dashboard: added from Amazon, linked to PO-030.'));
    assert.ok(say.includes('warning: Amazon has no shipment FBA99GONE001 on this account: check the ID on the bill.'));
    assert.ok(!say.some((m) => /isn't on the dashboard yet/.test(m)));
    // Only the bill's unknown IDs were asked about, and it didn't count as the daily check.
    assert.deepEqual(amazon.calls.filter((c) => c[0] === 'getShipments').map((c) => c[2]), ['ids']);
    assert.equal(db.prepare("SELECT count(*) n FROM sync_runs WHERE kind = 'amazon'").get().n, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
