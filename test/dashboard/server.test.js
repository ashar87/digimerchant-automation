// The dashboard end to end: real HTTP against an in-memory database. Made-up figures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger, auditTrail } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';

let db, server, base;

before(async () => {
  db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', name: 'Test leaf' }],
    orders: [{
      po: 'PO-001', supplier: 'Imported Supplier', marketplace: 'UK', review: 'needs_review', source: 'Tab X', importNotes: ['Check me'],
      invoices: [{ id: 'PO-001-final', kind: 'final', date: '2026-01-10', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 }] }],
    }],
    payments: [{ id: 'P-1', date: '2026-01-15', gbp: 200, allocations: [{ type: 'order', target: 'PO-001', part: 'full' }] }],
    courierBills: [],
    shipments: [{ id: 'FBA1TEST', marketplace: 'UK', status: 'SHIPPED', createdAt: '2026-02-01', items: [{ product: 'A-UK', po: 'PO-001', shipped: 100 }] }],
  }, { actor: 'test' });
  server = createDashboard({ db });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const get = (path, actor = 'Ashar') => fetch(base + path, { headers: actor ? { Cookie: `actor=${actor}` } : {}, redirect: 'manual' });
const post = (path, fields, { actor = 'Ashar', origin = base } = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
  return fetch(base + path, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { Cookie: `actor=${actor}`, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
};

test('asks who you are before anything else, and remembers it', async () => {
  const r = await get('/orders', null);
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/who\?next=/);
  const who = await post('/who', { actor: 'Atif', next: '/orders' }, { actor: '' });
  assert.equal(who.status, 303);
  assert.match(who.headers.get('set-cookie'), /actor=Atif/);
});

test('every page renders', async () => {
  for (const path of ['/', '/orders', '/orders/PO-001', '/payments', '/payments/new', '/payments/P-1', '/shipments', '/shipments/new', '/shipments/FBA1TEST', '/bills', '/costs', '/costs/FBA1TEST/A-UK', '/products', '/products/A-UK', '/annie', '/settings', '/orders/PO-001/invoices/PO-001-final']) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
  }
  assert.equal((await get('/orders/PO-404')).status, 404);
});

test('the inbox lists imported orders until someone checks them', async () => {
  assert.match(await (await get('/')).text(), /Imported order to check: PO-001/);
  const r = await post('/orders/PO-001/review', { back: '/' }, { actor: 'Atif' });
  assert.equal(r.status, 303);
  assert.doesNotMatch(await (await get('/')).text(), /Imported order to check: PO-001/);
  assert.equal(auditTrail(db, { entity: 'order', id: 'PO-001' })[0].actor, 'Atif');
});

test('a new order, its invoice and its payment produce a cost, all audited', async () => {
  const page = await (await get('/orders')).text();
  assert.match(page, /value="PO-002"/); // next PO suggested

  assert.equal((await post('/orders', { po: 'PO-002', supplier: 'New Supplier', marketplace: 'UK' })).status, 303);
  const inv = await post('/orders/PO-002/invoices', {
    kind: 'proforma', date: '2026-03-01', statedTotalRmb: '2,000',
    line_kind: ['goods', 'fee', 'goods'], line_product: ['A-UK', '', ''], line_qty: ['200', '', ''], line_rmb: ['1,980', '20', ''], line_description: ['', 'Agent 1%', ''],
  });
  assert.equal(inv.status, 303);
  const pay = await post('/payments', {
    date: '2026-03-02', reference: 'PO-002 full', usd: '400', qbRate: '0.75',
    alloc_type: ['order', 'order'], alloc_target: ['PO-002', ''], alloc_part: ['full', ''], alloc_usd: ['400', ''], alloc_rmb: ['', ''], alloc_description: ['', ''],
  });
  assert.equal(pay.status, 303);

  const order = loadLedger(db).orders.find((o) => o.po === 'PO-002');
  assert.equal(order.invoices[0].lines.length, 2);
  assert.equal(order.invoices[0].statedTotalRmb, '2000');
  assert.match(await (await get('/orders/PO-002')).text(), /£1\.5000/); // 400 × 0.75 / 200
  assert.equal(auditTrail(db, { entity: 'payment', id: 'P-2026-03-02' })[0].actor, 'Ashar');
});

test('linking a shipment line to an order by hand', async () => {
  const r = await post('/shipments', {
    id: 'fba2test', marketplace: 'UK', name: 'PO-002 UK', status: 'CLOSED', createdAt: '2026-03-10', firstReceivedAt: '2026-03-12',
    item_product: ['A-UK', ''], item_po: ['PO-002', ''], item_shipped: ['200', ''], item_received: ['198', ''],
  });
  assert.equal(r.status, 303);
  const s = loadLedger(db).shipments.find((x) => x.id === 'FBA2TEST');
  assert.deepEqual(s.items, [{ product: 'A-UK', po: 'PO-002', shipped: '200', received: '198' }]);
});

test('bad input is refused with a reason, and nothing is written', async () => {
  const r = await post('/payments', { date: '2026-03-02', usd: 'abc', alloc_type: 'order', alloc_target: 'PO-002' });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /USD isn&#39;t a number/);
  assert.equal((await post('/payments', { date: '2026-03-03', usd: '5', alloc_type: 'order', alloc_target: 'PO-999' })).status, 400);
  assert.equal((await post('/orders', { po: 'PO-002', supplier: 'Dup', marketplace: 'UK' })).status, 400);
});

test('a form posted from another site is refused', async () => {
  const r = await post('/settings', { cutover_date: '2026-11-01' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('names typed into forms are shown as text, never markup', async () => {
  await post('/orders', { po: 'PO-003', supplier: '<script>alert(1)</script>', marketplace: 'US' });
  const page = await (await get('/orders')).text();
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&lt;script&gt;'));
});

test('cutover date is a setting, unset until chosen', async () => {
  assert.match(await (await get('/')).text(), /No cutover date yet/);
  await post('/settings', { cutover_date: '2026-11-01' });
  assert.doesNotMatch(await (await get('/')).text(), /No cutover date yet/);
});
