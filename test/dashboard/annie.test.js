// Annie's account on the Payments page: carried rate differences and credit. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { annieEntries } from '../../src/dashboard/views/annie.js';
import { createDashboard } from '../../src/dashboard/server.js';

function db() {
  const d = openLandingDb(':memory:');
  saveLedger(d, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [
      { po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', date: '2026-07-01', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }, { kind: 'adjustment', rmb: 15, description: 'Last time payment rate difference' }] }] },
      { po: 'PO-002', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i2', kind: 'final', date: '2026-07-30', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }, { kind: 'adjustment', rmb: 50, description: 'Fees folded into SKUs (service 20, rate diff 4)' }] }] },
    ],
    payments: [{ id: 'P1', date: '2026-10-02', usd: 100, gbp: 80, allocations: [{ type: 'order', target: 'PO-001', part: 'full', usd: 91 }, { type: 'credit', target: 'Annie', usd: 9, description: 'Paid over the invoices, carried forward' }] }],
  }, { actor: 'test' });
  return d;
}

test('only real carried differences and credits count; a fee bundle that mentions "rate diff" does not', () => {
  const e = annieEntries(loadLedger(db()));
  assert.deepEqual(e.map((x) => x.source), ['PO-001', 'P1']);
});

test('the credit shows on the Payments page, and the old Annie tab is gone but its link still lands there', async () => {
  const server = createDashboard({ db: db() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(`${base}/payments`, { headers: { Cookie: 'actor=Ashar' } })).text();
    assert.match(page, /Credit with Annie: \$9\.00<\/b> carried forward\. Check her next invoice deducts it\./);
    assert.match(page, /Rate differences and credits \(2\)/);
    assert.doesNotMatch(page, />Annie<\/a>/); // no tab
    const old = await fetch(`${base}/annie`, { headers: { Cookie: 'actor=Ashar' }, redirect: 'manual' });
    assert.equal(old.headers.get('location'), '/payments#annie');
  } finally {
    server.close();
  }
});
