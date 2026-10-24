// The Annie credit card is gone from the Payments page; the old /annie link still lands there. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';

test('no "Credit with Annie" on the Payments page, even with a credit recorded; /annie lands on Payments', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [{ po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', date: '2026-07-01', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }] }],
    payments: [{ id: 'P1', date: '2026-10-02', usd: 100, gbp: 80, allocations: [{ type: 'order', target: 'PO-001', part: 'full', usd: 91 }, { type: 'credit', target: 'Annie', usd: 9, description: 'Paid over the invoices, carried forward' }] }],
  }, { actor: 'test' });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/payments`, { headers: { Cookie: 'actor=Ashar' } })).text();
    assert.doesNotMatch(page, /Credit with Annie|carried forward\. Check her next invoice/);
    assert.match(page, /href="\/payments\/P1"/);
    const old = await fetch(`${base}/annie`, { headers: { Cookie: 'actor=Ashar' }, redirect: 'manual' });
    assert.equal(old.headers.get('location'), '/payments');
  } finally {
    server.close();
  }
});
