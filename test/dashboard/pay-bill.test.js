// Courier bills sit under Purchasing, and "Pay bill" opens the payment with the bill filled in. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';

test('Pay bill fills in the payment for the bill; once paid the bill says so', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-US', code: 'A', marketplace: 'US' }, { id: 'A-DE', code: 'A', marketplace: 'DE' }],
    shipments: [{ id: 'FBA99US00001', marketplace: 'US', items: [{ product: 'A-US', shipped: 10 }] }, { id: 'FBA99DE00001', marketplace: 'DE', items: [{ product: 'A-DE', shipped: 10 }] }],
    courierBills: [{ id: 'ANNIE-2026-10-19', agent: 'Annie', date: '2026-10-19', statedTotalRmb: 660, rmbPerUsd: 6.6, lines: [{ kind: 'shipping', shipment: 'FBA99US00001', rmb: 330 }, { kind: 'shipping', shipment: 'FBA99DE00001', rmb: 330 }] }],
  }, { actor: 'test' });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: 'actor=Ashar', Origin: base };
  const page = async (p) => (await fetch(base + p, { headers })).text();
  try {
    const list = await page('/bills');
    assert.match(list, /<a href="\/bills" class="on" aria-current="page">Courier bills<\/a>/);
    assert.match(list, /<a[^>]*href="\/invoices"[^>]*>Invoices<\/a><a[^>]*href="\/bills"/); // next to Invoices, under Purchasing
    assert.match(list, /<a href="\/payments\/new\?bill=ANNIE-2026-10-19">Pay bill<\/a>/);
    assert.match(await page('/bills/ANNIE-2026-10-19'), /class="button" href="\/payments\/new\?bill=ANNIE-2026-10-19">Pay bill/);

    const form = await page('/payments/new?bill=ANNIE-2026-10-19');
    assert.match(form, /Paying courier bill .*ANNIE-2026-10-19.*660 RMB at 6.6 = about \$100.00\..*It covers UK or DE shipments/s);
    assert.match(form, /name="reference" value="ANNIE-2026-10-19 shipping"/);
    assert.match(form, /<option value="bill" selected>Courier bill<\/option>/);
    assert.match(form, /name="alloc_target" list="targets" value="ANNIE-2026-10-19"/);
    assert.match(form, /name="alloc_rmb" inputmode="decimal" value="660"/);
    assert.equal((await fetch(`${base}/payments/new?bill=NOPE`, { headers })).status, 404);

    const body = new URLSearchParams({ date: '2026-10-20', reference: 'ANNIE-2026-10-19 shipping', usd: '100', gbp: '75' });
    for (const [k, v] of [['alloc_type', 'bill'], ['alloc_target', 'ANNIE-2026-10-19'], ['alloc_part', ''], ['alloc_usd', ''], ['alloc_rmb', '660'], ['alloc_description', '']]) body.append(k, v);
    const saved = await fetch(`${base}/payments`, { method: 'POST', body, redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(saved.status, 303);
    assert.equal(loadLedger(db).payments.length, 1);
    const paid = await page('/bills/ANNIE-2026-10-19');
    assert.match(paid, /paid by <a href="\/payments\//);
    assert.doesNotMatch(paid, /Pay bill/);
  } finally {
    server.close();
  }
});
