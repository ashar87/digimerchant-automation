// Editing a PO's details, and taking off a write-off entered by mistake. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';

test('supplier and notes can be edited; the marketplace only while nothing depends on it', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [
      { po: 'PO-001', supplier: 'Typo Supplier', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'proforma', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }], writeOffs: [{ product: 'A-UK', qty: 1, reason: 'damaged' }, { product: 'A-UK', qty: 2, reason: 'mistake' }] },
      { po: 'PO-002', supplier: 'S', marketplace: 'UK', invoices: [] },
    ],
  }, { actor: 'test' });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Atif' } })).text();
  const version = async (po) => (await page(`/orders/${po}`)).match(/action="\/orders\/[^"]+\/edit"><input type="hidden" name="version" value="([0-9a-f]+)"/)[1];
  const post = (p, fields) => fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields), headers: { Cookie: 'actor=Atif', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const order = (po) => loadLedger(db).orders.find((o) => o.po === po);
  try {
    assert.match(await page('/orders/PO-001'), /Marketplace \(fixed: it has invoices\)/);
    assert.equal((await post('/orders/PO-001/edit', { version: await version('PO-001'), supplier: 'Nanjing Yongbo', notes: 'gold-priced' })).status, 303);
    assert.equal(order('PO-001').supplier, 'Nanjing Yongbo');
    assert.equal(order('PO-001').notes, 'gold-priced');
    assert.equal(order('PO-001').invoices.length, 1); // the invoice survives the edit

    const moved = await post('/orders/PO-001/edit', { version: await version('PO-001'), supplier: 'Nanjing Yongbo', marketplace: 'US' });
    assert.equal(moved.status, 400);
    assert.match(await moved.text(), /marketplace can&#39;t change now that it has invoices/);
    assert.equal(order('PO-001').marketplace, 'UK');

    assert.equal((await post('/orders/PO-002/edit', { version: await version('PO-002'), supplier: 'S', marketplace: 'DE' })).status, 303);
    assert.equal(order('PO-002').marketplace, 'DE');
    assert.equal((await post('/orders/PO-002/edit', { version: await version('PO-002'), supplier: '' })).status, 400);

    // Remove the second write-off only.
    assert.equal((await post('/orders/PO-001/write-offs/1/delete', { version: await version('PO-001') })).status, 303);
    assert.deepEqual(order('PO-001').writeOffs.map((w) => w.reason), ['damaged']);
    assert.equal((await post('/orders/PO-001/write-offs/5/delete', { version: await version('PO-001') })).status, 400);
  } finally {
    server.close();
  }
});
