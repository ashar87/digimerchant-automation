// Courier bills and the Sellerboard page through the dashboard. Made-up figures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';
import { unsent } from '../../src/notify/outbox.js';
import { versionOf } from '../../src/dashboard/versions.js';

let db, server, base;
const written = [];

before(async () => {
  db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', sku: 'SKU-A' }],
    orders: [{ po: 'PO-1', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', date: '2026-01-01', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 }] }] }],
    payments: [{ id: 'P1', date: '2026-01-01', gbp: 100, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }],
    courierBills: [],
    shipments: [
      { id: 'FBAOLD1', marketplace: 'UK', status: 'CLOSED', createdAt: '2025-12-01', items: [{ product: 'A-UK', shipped: 10, received: 10 }] },
      { id: 'FBANEW1', marketplace: 'UK', status: 'CLOSED', createdAt: '2026-01-10', firstReceivedAt: '2026-01-12', items: [{ product: 'A-UK', po: 'PO-1', shipped: 100, received: 100 }] },
    ],
  }, { actor: 'test' });
  const sheets = { replaceTab: async (values) => (written.push(values), { rows: values.length - 1 }) };
  server = createDashboard({ db, sheets });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const page = async (path) => (await fetch(base + path, { headers: { Cookie: 'actor=Ashar' } })).text();
const post = (path, fields) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
  return fetch(base + path, { method: 'POST', body, redirect: 'manual', headers: { Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } });
};

test('a courier bill entered on the dashboard turns an estimate into a billed delivery cost, with a card', async () => {
  // An earlier bill gives the estimate: £0.50 a unit.
  assert.equal((await post('/bills', { agent: 'Agent', date: '2025-12-20', statedTotalRmb: '100', rmbPerUsd: '7', line_kind: 'shipping', line_shipment: 'fbaold1', line_rmb: '100', line_description: '' })).status, 303);
  assert.equal((await post('/payments', { date: '2025-12-21', reference: 'Agent bill', gbp: '5', alloc_type: 'bill', alloc_target: 'AGENT-2025-12-20', alloc_part: '', alloc_usd: '', alloc_rmb: '100', alloc_description: '' })).status, 303);
  assert.match(await page('/shipments/FBANEW1'), /Estimated from FBAOLD1/);

  const r = await post('/bills', {
    agent: 'Agent', date: '2026-01-15', statedTotalRmb: '1,000', rmbPerUsd: '7',
    line_kind: ['shipping', 'domestic', 'fee', 'shipping'], line_shipment: ['FBANEW1', 'FBANEW1', '', ''], line_rmb: ['900', '50', '50', ''], line_description: ['', '', 'Agent 1%', ''],
  });
  assert.equal(r.status, 303);
  assert.equal((await post('/payments', { date: '2026-01-16', reference: 'Agent bill', gbp: '20', alloc_type: 'bill', alloc_target: 'AGENT-2026-01-15', alloc_part: '', alloc_usd: '', alloc_rmb: '1000', alloc_description: '' })).status, 303);
  const bill = loadLedger(db).courierBills.find((b) => b.id === 'AGENT-2026-01-15');
  assert.equal(bill.lines.length, 3);
  assert.match(await page('/bills/AGENT-2026-01-15'), /FBANEW1/);
  const card = unsent(db).find((c) => c.kind === 'bill_saved' && c.text.includes('AGENT-2026-01-15'));
  assert.match(card.text, /Courier bill AGENT-2026-01-15/);
  assert.match(card.text, /FBANEW1 \(UK\): delivery .*£0\.2000 a unit/);
});

test('the Sellerboard page lists the rows, offers the CSV, and writes the sheet', async () => {
  const html = await page('/sellerboard');
  assert.match(html, /1 row for Sellerboard/);
  const csv = await fetch(`${base}/sellerboard.csv`, { headers: { Cookie: 'actor=Ashar' } });
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const text = await csv.text();
  assert.match(text, /^ASIN,SKU,CostPeriodStartDate,Cost,Marketplace,BatchQuantity\r\n/);
  assert.match(text, /,SKU-A,12\/01\/2026,1\.2000,Amazon\.co\.uk,100\r\n/);
  const r = await post('/sellerboard/publish', {});
  assert.equal(r.status, 303);
  assert.equal(written.at(-1).length, 2);
  assert.match(await page('/sellerboard'), /last written/);
});

test('ticking “typed into Sellerboard by hand” takes a shipment out of the feed', async () => {
  await post('/shipments/FBANEW1', { version: versionOf(loadLedger(db).shipments.find((s) => s.id === 'FBANEW1')), marketplace: 'UK', status: 'CLOSED', createdAt: '2026-01-10', firstReceivedAt: '2026-01-12', sellerboardManual: '1', item_product: 'A-UK', item_po: 'PO-1', item_shipped: '100', item_received: '100' });
  assert.match(await page('/sellerboard'), /0 rows for Sellerboard/);
});

test('the test download can include batches typed in by hand, and narrow to one shipment', async () => {
  const csv = async (q) => (await fetch(`${base}/sellerboard.csv${q}`, { headers: { Cookie: 'actor=Ashar' } })).text();
  assert.doesNotMatch(await csv(''), /FBANEW1/); // typed by hand: left out of the normal file
  assert.match(await csv('?all=1'), /,SKU-A,12\/01\/2026,1\.2000,Amazon\.co\.uk,100/);
  assert.match(await csv('?all=1&shipment=FBANEW1'), /SKU-A/);
  assert.equal((await csv('?all=1&shipment=FBANOPE')).trim().split('\n').length, 1); // just the header
  assert.match(await page('/sellerboard'), /Testing the import, or comparing/);
});
