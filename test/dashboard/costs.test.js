// The landing costs page shows when each batch landed at Amazon. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';

test('each batch shows the day Amazon started receiving it, or — until it lands', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [{ po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 20, rmb: 200 }] }] }],
    payments: [{ id: 'P1', date: '2026-01-01', gbp: 20, allocations: [{ type: 'order', target: 'PO-001', part: 'full' }] }],
    shipments: [
      { id: 'FBA99LANDED1', marketplace: 'UK', status: 'RECEIVING', firstReceivedAt: '2026-02-03', items: [{ product: 'A-UK', po: 'PO-001', shipped: 10, received: 4 }] },
      { id: 'FBA99ONWAY01', marketplace: 'UK', status: 'SHIPPED', items: [{ product: 'A-UK', po: 'PO-001', shipped: 10 }] },
    ],
  }, { actor: 'test' });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/costs`, { headers: { Cookie: 'actor=Ashar' } })).text();
    assert.match(page, /<th>Shipment<\/th><th>Landed<\/th>/);
    assert.match(page, />FBA99LANDED1<\/a><\/td><td>2026-02-03<\/td>/);
    assert.match(page, />FBA99ONWAY01<\/a><\/td><td><span class="muted">—<\/span><\/td>/);
  } finally {
    server.close();
  }
});
