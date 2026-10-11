// Paying a deposit or balance from the order page: the right buttons, and the amounts filled in. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';

test('Pay deposit fills in 30% of the invoice; once paid, Pay balance fills in the rest', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-US', code: 'A', marketplace: 'US' }],
    orders: [{ po: 'PO-030', supplier: 'S', marketplace: 'US', invoices: [{ id: 'i30', kind: 'proforma', lines: [{ kind: 'goods', product: 'A-US', qty: 100, rmb: 10000 }] }] }],
  }, { actor: 'test' });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Ashar' } })).text();
  try {
    let order = await page('/orders/PO-030');
    assert.match(order, /href="\/payments\/new\?po=PO-030&amp;part=deposit">Pay deposit/);
    assert.match(order, /Pay in full/);
    assert.match(order, /action="\/invoices\/upload" enctype="multipart\/form-data"><input type="hidden" name="po" value="PO-030">/);

    const form = await page('/payments/new?po=PO-030&part=deposit');
    assert.match(form, /Deposit for <a href="\/orders\/PO-030">PO-030<\/a>: 3,000 RMB \(30% of the invoice\)/);
    assert.match(form, /name="reference" value="PO-030 30%"/);
    assert.match(form, /<option value="deposit" selected>Deposit<\/option>/);
    assert.match(form, /name="alloc_rmb" inputmode="decimal" value="3000"/);

    const res = await fetch(`${base}/payments`, {
      method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ date: '2026-10-01', reference: 'PO-030 30%', usd: '420', alloc_type: 'order', alloc_target: 'PO-030', alloc_part: 'deposit', alloc_usd: '420', alloc_rmb: '3000' }),
      headers: { Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^\/orders\/PO-030\?ok=/); // back to the order

    order = await page('/orders/PO-030');
    assert.match(order, /part=balance">Pay balance/);
    // Payments live inside the invoice they pay; there's no separate section.
    assert.doesNotMatch(order, /<h2>Payments/);
    assert.match(order, /<div class="paid"><h3>Paid<\/h3>[\s\S]*<b>Deposit<\/b> · \$420\.00 · 3,000 RMB[\s\S]*no receipt yet/);
    assert.match(order, /\$420\.00 paid · for 3,000 of 10,000 RMB · 7,000 RMB outstanding · rate ≈ 7\.14 RMB per \$/);
    assert.doesNotMatch(order, /Pay deposit/);
    const balance = await page('/payments/new?po=PO-030&part=balance');
    assert.match(balance, /7,000 RMB \(what’s still unpaid\)/);
    assert.match(balance, /<option value="balance" selected>Balance<\/option>/);
  } finally {
    server.close();
  }
});
