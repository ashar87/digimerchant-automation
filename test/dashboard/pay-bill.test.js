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
    courierBills: [{ id: 'BILL-2026-10-19', agent: 'Annie', date: '2026-10-19', statedTotalRmb: 660, rmbPerUsd: 6.6, lines: [{ kind: 'shipping', shipment: 'FBA99US00001', rmb: 330 }, { kind: 'shipping', shipment: 'FBA99DE00001', rmb: 330 }] }],
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
    assert.match(list, /<a href="\/payments\/new\?bill=BILL-2026-10-19">Pay bill<\/a>/);
    assert.match(await page('/bills/BILL-2026-10-19'), /class="button" href="\/payments\/new\?bill=BILL-2026-10-19">Pay bill/);

    const form = await page('/payments/new?bill=BILL-2026-10-19');
    assert.match(form, /Paying courier bill .*BILL-2026-10-19.*660 RMB at 6.6 = about \$100.00\..*It covers UK or DE shipments/s);
    assert.match(form, /name="reference" value="BILL-2026-10-19 shipping"/);
    assert.match(form, /<option value="bill" selected>Courier bill<\/option>/);
    assert.match(form, /name="alloc_target" list="targets" value="BILL-2026-10-19"/);
    assert.match(form, /name="alloc_rmb" inputmode="decimal" value="660"/);
    assert.equal((await fetch(`${base}/payments/new?bill=NOPE`, { headers })).status, 404);

    const body = new URLSearchParams({ date: '2026-10-20', reference: 'BILL-2026-10-19 shipping', usd: '100', gbp: '75' });
    for (const [k, v] of [['alloc_type', 'bill'], ['alloc_target', 'BILL-2026-10-19'], ['alloc_part', ''], ['alloc_usd', ''], ['alloc_rmb', '660'], ['alloc_description', '']]) body.append(k, v);
    const saved = await fetch(`${base}/payments`, { method: 'POST', body, redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(saved.status, 303);
    assert.equal(loadLedger(db).payments.length, 1);
    const paid = await page('/bills/BILL-2026-10-19');
    assert.match(paid, /paid by <a href="\/payments\//);
    assert.doesNotMatch(paid, /Pay bill/);
  } finally {
    server.close();
  }
});

test('a payment that can’t be saved comes back on the same form, with what was typed and why', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    shipments: [{ id: 'FBA99UK00001', marketplace: 'UK', items: [{ product: 'A-UK', shipped: 10 }] }],
    courierBills: [
      { id: 'BILL-2026-10-19', agent: 'Annie', date: '2026-10-19', statedTotalRmb: 2044, rmbPerUsd: 6.6, lines: [{ kind: 'shipping', shipment: 'FBA99UK00001', rmb: 2044 }] },
      { id: 'BILL-2026-10-22', agent: 'Annie', date: '2026-10-19', statedTotalRmb: 4161, rmbPerUsd: 6.6, lines: [{ kind: 'shipping', shipment: 'FBA99UK00001', rmb: 4161 }] },
    ],
  }, { actor: 'test' });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' };
  const send = (fields, rowsIn) => {
    const body = new URLSearchParams(fields);
    for (const r of rowsIn) for (const [k, v] of Object.entries(r)) body.append(`alloc_${k}`, v);
    return fetch(`${base}/payments`, { method: 'POST', body, redirect: 'manual', headers });
  };
  const row = (target, rmb) => ({ type: 'bill', target, part: '', usd: '', rmb, description: '' });
  try {
    // Two bills, one with no amount: refused, and shown again on the form.
    const res = await send({ date: '2026-10-24', reference: 'Annie two bills', usd: '941', gbp: '' }, [row('BILL-2026-10-22', '4161'), row('BILL-2026-10-19', '')]);
    assert.equal(res.status, 400);
    const page = await res.text();
    assert.match(page, /<h1>Record a payment<\/h1>/);
    assert.match(page, /role="alert"[^>]*><b>Not saved\.<\/b> Row 2: enter the amount of the bill it pays\. Everything you typed is still below\./);
    assert.match(page, /name="reference" value="Annie two bills"/);
    assert.match(page, /name="usd" inputmode="decimal" data-one-of="sent" value="941"/);
    assert.match(page, /name="alloc_target" list="targets" value="BILL-2026-10-22"/);
    assert.match(page, /name="alloc_target" list="targets" value="BILL-2026-10-19"/);
    assert.match(page, /name="date" value="2026-10-24"/);

    // UK shipments paid from USD with no GBP: also back on the form, saying what's needed.
    const rate = await send({ date: '2026-10-24', reference: 'Annie two bills', usd: '941' }, [row('BILL-2026-10-22', '4161'), row('BILL-2026-10-19', '2044')]);
    assert.equal(rate.status, 400);
    assert.match(await rate.text(), /Not saved\.<\/b> This pays a UK or DE order or courier bill from USD with no GBP amount, so it needs the QB rate for 2026-10-24/);

    const ok = await send({ date: '2026-10-24', reference: 'Annie two bills', usd: '941', qbRate: '0.75' }, [row('BILL-2026-10-22', '4161'), row('BILL-2026-10-19', '2044')]);
    assert.equal(ok.status, 303);
    assert.equal(loadLedger(db).payments.length, 1);
  } finally {
    server.close();
  }
});
