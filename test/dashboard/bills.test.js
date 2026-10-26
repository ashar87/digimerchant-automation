// Courier bills and the Sellerboard page through the dashboard. Made-up figures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';
import { unsent } from '../../src/notify/outbox.js';
import { versionOf } from '../../src/dashboard/versions.js';
import ExcelJS from 'exceljs';
import { HEADERS } from '../../src/sellerboard/feed.js';

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
  const sheets = { 'uk-de': { replaceTab: async (values) => (written.push(values), { rows: values.length - 1 }) } };
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
  assert.equal((await post('/payments', { date: '2025-12-21', reference: 'Agent bill', gbp: '5', alloc_type: 'bill', alloc_target: 'BILL-2025-12-20', alloc_part: '', alloc_usd: '', alloc_rmb: '100', alloc_description: '' })).status, 303);
  assert.match(await page('/shipments/FBANEW1'), /Estimated from FBAOLD1/);

  const r = await post('/bills', {
    agent: 'Agent', date: '2026-01-15', statedTotalRmb: '1,000', rmbPerUsd: '7',
    line_kind: ['shipping', 'domestic', 'fee', 'shipping'], line_shipment: ['FBANEW1', 'FBANEW1', '', ''], line_rmb: ['900', '50', '50', ''], line_description: ['', '', 'Agent 1%', ''],
  });
  assert.equal(r.status, 303);
  assert.equal((await post('/payments', { date: '2026-01-16', reference: 'Agent bill', gbp: '20', alloc_type: 'bill', alloc_target: 'BILL-2026-01-15', alloc_part: '', alloc_usd: '', alloc_rmb: '1000', alloc_description: '' })).status, 303);
  const bill = loadLedger(db).courierBills.find((b) => b.id === 'BILL-2026-01-15');
  assert.equal(bill.lines.length, 3);
  assert.match(await page('/bills/BILL-2026-01-15'), /FBANEW1/);
  const card = unsent(db).find((c) => c.kind === 'bill_saved' && c.text.includes('BILL-2026-01-15'));
  assert.match(card.text, /Courier bill BILL-2026-01-15/);
  assert.match(card.text, /FBANEW1 \(UK\): delivery .*£0\.2000 a unit/);
});

const xlsxRows = async (q) => {
  const res = await fetch(`${base}/sellerboard.xlsx${q}`, { headers: { Cookie: 'actor=Ashar' } });
  if (res.status !== 200) return res.status;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const rows = [];
  wb.worksheets[0].eachRow((r) => rows.push(r.values.slice(1)));
  return rows;
};

test('the Sellerboard page waits for Sellerboard’s product list, then offers each account’s import file and writes its sheet', async () => {
  assert.match(await page('/sellerboard'), /product list for the UK \+ DE account isn’t uploaded/);

  // Sellerboard's own export for the UK + DE account, uploaded on the page.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('TDSheet');
  ws.addRow(HEADERS);
  ws.addRow(HEADERS.map((h) => ({ ASIN: 'B000UK', SKU: 'SKU-A', Title: 'Product A', Hide: 'NO', VAT: 20, Marketplace: 'Amazon.co.uk' })[h] ?? null));
  const upload = new FormData();
  upload.append('account', 'us');
  upload.append('file', new Blob([await wb.xlsx.writeBuffer()]), 'export.xlsx');
  const send = (form) => fetch(`${base}/sellerboard/catalog`, { method: 'POST', body: form, redirect: 'manual', headers: { Cookie: 'actor=Ashar', Origin: base } });
  assert.equal((await send(upload)).status, 400); // a UK + DE export offered as the US one
  upload.set('account', 'uk-de');
  assert.equal((await send(upload)).status, 303);

  const html = await page('/sellerboard');
  assert.match(html, /UK \+ DE account \(GBP\): 1 row</);
  assert.match(html, /US account \(USD\): 0 rows/);
  assert.match(html, /Sellerboard’s product list: 1 rows, uploaded/);
  assert.equal(await xlsxRows(''), 400); // which account?
  assert.equal((await xlsxRows('?account=us')).length, 1); // just the header
  const rows = await xlsxRows('?account=uk-de');
  assert.deepEqual(rows[0], HEADERS);
  assert.deepEqual([rows[1][0], rows[1][1], rows[1][2], rows[1][4], rows[1][5], rows[1][10], rows[1][13], rows[1][14]], ['B000UK', 'SKU-A', 'Product A', '12/01/2026', 1.2, 20, 'Amazon.co.uk', 100]);
  const r = await post('/sellerboard/publish', {});
  assert.equal(r.status, 303);
  assert.equal(written.at(-1).length, 2);
  assert.match(await page('/sellerboard'), /last written/);
  assert.match(await page('/sellerboard'), /US account[\s\S]*Google Sheet not set up/);
});

test('a batch Sellerboard should get is in the Inbox and on WhatsApp until it is marked done', async () => {
  // First carded at the estimated delivery cost; the bill's cost replaced it before it was added.
  const [first, card] = unsent(db).filter((c) => c.kind === 'sellerboard');
  assert.match(first.text, /£1\.50/);
  assert.equal(first.reply, 'superseded');
  assert.match(card.text, /📥 Add to Sellerboard \(UK \+ DE account\)\nSKU-A · Amazon\.co\.uk · FBANEW1\nBatch date 12\/01\/2026 · 100 units · £1\.20/);
  assert.match(await page('/'), /Add to Sellerboard: SKU-A Amazon\.co\.uk · FBANEW1/);
  assert.match(await page('/sellerboard'), /To add \(1\)/);
  const r = await post('/sellerboard/done', { shipment: 'FBANEW1', product: 'A-UK', back: '/' });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /marked as in Sellerboard \(£1\.20, 100 units\)/);
  assert.doesNotMatch(await page('/'), /Add to Sellerboard/);
  assert.match(await page('/sellerboard'), /In Sellerboard \(1\)/);
  assert.equal((await post('/sellerboard/done', { shipment: 'FBANOPE', product: 'A-UK' })).status, 400);
});

test('ticking “typed into Sellerboard by hand” takes a shipment out of the feed', async () => {
  await post('/shipments/FBANEW1', { version: versionOf(loadLedger(db).shipments.find((s) => s.id === 'FBANEW1')), marketplace: 'UK', status: 'CLOSED', createdAt: '2026-01-10', firstReceivedAt: '2026-01-12', sellerboardManual: '1', item_product: 'A-UK', item_po: 'PO-1', item_shipped: '100', item_received: '100' });
  assert.match(await page('/sellerboard'), /UK \+ DE account \(GBP\): 0 rows/);
});

test('the comparison download can include batches typed in by hand, and narrow to one shipment', async () => {
  assert.equal((await xlsxRows('?account=uk-de')).length, 1); // typed by hand: left out of the normal file
  assert.equal((await xlsxRows('?account=uk-de&all=1'))[1][1], 'SKU-A');
  assert.equal((await xlsxRows('?account=uk-de&all=1&shipment=FBANEW1')).length, 2);
  assert.equal((await xlsxRows('?account=uk-de&all=1&shipment=FBANOPE')).length, 1); // just the header
  assert.match(await page('/sellerboard'), /Comparing with what's in Sellerboard/);
});
