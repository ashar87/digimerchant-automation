// The orders list: new order first, then filters and pages. Made-up figures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';

let server, base;

before(async () => {
  const db = openLandingDb(':memory:');
  const products = ['UK', 'DE', 'US'].map((m) => ({ id: `A-${m}`, code: 'A', marketplace: m, name: `Leaf ${m}` }));
  const orders = [];
  const payments = [];
  for (let n = 1; n <= 45; n++) {
    const marketplace = ['UK', 'DE', 'US'][n % 3];
    const po = `PO-${String(n).padStart(3, '0')}`;
    orders.push({ po, supplier: n === 7 ? 'Special Supplier' : 'Supplier', marketplace, review: n % 2 ? 'needs_review' : null, invoices: [{ id: `i${n}`, kind: 'final', lines: [{ kind: 'goods', product: `A-${marketplace}`, qty: 10, rmb: 100 }] }] });
    if (n % 5 === 0) payments.push({ id: `P${n}`, date: '2026-01-01', gbp: 10, usd: 13, allocations: [{ type: 'order', target: po, part: 'full', usd: 13 }] });
  }
  saveLedger(db, { products, orders, payments, courierBills: [], shipments: [] }, { actor: 'test' });
  server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const page = async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Ashar' } })).text();
const pos = (html) => [...html.matchAll(/<td><a href="\/orders\/(PO-\d+)">/g)].map((m) => m[1]);

test('the new-order form comes before the list, and the newest orders come first, 20 a page', async () => {
  const html = await page('/orders');
  assert.ok(html.indexOf('New order') < html.indexOf('Showing'));
  assert.deepEqual(pos(html).slice(0, 3), ['PO-045', 'PO-044', 'PO-043']);
  assert.equal(pos(html).length, 20);
  assert.match(html, /Showing 1–20 of 45/);
  assert.match(html, /Page 1 of 3/);
  const last = await page('/orders?page=3');
  assert.deepEqual(pos(last), ['PO-005', 'PO-004', 'PO-003', 'PO-002', 'PO-001']);
  assert.match(await page('/orders?page=99'), /Page 3 of 3/); // out of range lands on the last page
});

test('filters by market, status, checked and search, and keep the filter across pages', async () => {
  const uk = await page('/orders?market=UK');
  assert.match(uk, /Showing 1–15 of 15 \(of 45 in all\)/);
  assert.ok(pos(uk).every((po) => Number(po.slice(3)) % 3 === 0));

  const paid = await page('/orders?stage=ready');
  assert.deepEqual(pos(paid), ['PO-045', 'PO-040', 'PO-035', 'PO-030', 'PO-025', 'PO-020', 'PO-015', 'PO-010', 'PO-005']);

  const toCheck = await page('/orders?check=to_check');
  assert.match(toCheck, /of 23 \(of 45/);
  assert.match(toCheck, /href="\/orders\?check=to_check&amp;page=2"/);

  assert.deepEqual(pos(await page('/orders?q=special')), ['PO-007']);
  assert.match(await page('/orders?market=US&stage=complete'), /No orders match/);
});
