// Uploading, checking and saving an invoice; recording a Wise transfer; a QB rate lookup. Made-up figures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';
import { saveTransfers } from '../../src/wise/import.js';
import { sampleXlsx } from '../invoices/invoices.test.js';

let db, server, base, dir;
const qbo = { exchangeRate: async (currency, date) => ({ rate: '0.79', asOf: date, target: 'GBP' }) };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-inv-'));
  process.env.INVOICE_DIR = dir; // read when intake.js loads, which happens on first import below
  db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'T10-US', code: 'T10', marketplace: 'US', name: 'Test gold leaf 10pcs/pack' }, { id: 'T30-US', code: 'T30', marketplace: 'US', name: 'Test gold leaf 30pcs/pack' }, { id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [{ po: 'PO-030', supplier: 'UK Supplier', marketplace: 'UK', invoices: [{ id: 'u1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }] }],
    payments: [{ id: 'P-NEEDS-RATE', date: '2026-03-04', usd: 50, allocations: [{ type: 'order', target: 'PO-030', part: 'full' }] }],
  }, { actor: 'test' });
  saveTransfers(db, [{ id: 777, created: '2026-03-10 09:00:00', status: 'outgoing_payment_sent', reference: 'PO-030 balance', sourceCurrency: 'GBP', sourceValue: 40, targetCurrency: 'USD', targetValue: 53 }]);
  server = createDashboard({ db, qbo });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const page = async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Ashar' } })).text();
const post = (p, body, extra = {}) => fetch(base + p, { method: 'POST', body, redirect: 'manual', headers: { Cookie: 'actor=Ashar', Origin: base, ...extra } });
const formOf = (fields) => {
  const b = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) b.append(k, x);
  return b;
};

test('upload an Excel invoice, see the checks, save it to a new PO with the original attached', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([await sampleXlsx()]), 'PI-0001.xlsx');
  fd.append('po', '');
  const r = await post('/invoices/upload', fd);
  assert.equal(r.status, 303);
  const draftUrl = r.headers.get('location');
  assert.match(draftUrl, /^\/invoices\/drafts\/\d+$/);

  const review = await page(draftUrl);
  assert.match(review, /Read exactly from the Excel file/);
  assert.match(review, /Lines add up to the invoice total, 10,630 RMB ✓/);
  assert.match(review, /Marketplace printed on the invoice: <b>USA<\/b>/);
  assert.match(await page('/'), /Invoice to check: PI-0001\.xlsx/);
  const file = await fetch(`${base}${draftUrl}/file`, { headers: { Cookie: 'actor=Ashar' } });
  assert.equal(file.status, 200);

  const saved = await post(`${draftUrl}/save`, formOf({
    po: 'PO-031', supplier: 'Test Supplier', marketplace: 'US', kind: 'proforma', date: '2026-09-21', supplierRef: 'PI-0001', statedTotalRmb: '10630',
    line_kind: ['goods', 'goods', 'labour', 'fee'], line_product: ['T10-US', 'T30-US', '', ''], line_qty: ['200', '50', '', ''], line_rmb: ['6000', '4500', '25', '105'], line_description: ['', '', 'Packing labour', 'Service fee 1%'],
  }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(saved.status, 303);
  const order = loadLedger(db).orders.find((o) => o.po === 'PO-031');
  assert.equal(order.marketplace, 'US');
  assert.equal(order.invoices[0].lines.length, 4);
  assert.match(order.invoices[0].filePath, /\.xlsx$/);
  assert.doesNotMatch(await page('/'), /Invoice to check: PI-0001/);
});

test('a Wise transfer is recorded as a payment from a prefilled form', async () => {
  const form = await page('/payments/new?wise=777');
  assert.match(form, /Filled in from the Wise transfer of 2026-03-10/);
  assert.match(form, /name="gbp" inputmode="decimal" data-one-of="sent" value="40"/);
  assert.match(form, /value="PO-030"/);
  const r = await post('/payments', formOf({ wise: '777', date: '2026-03-10', reference: 'PO-030 balance', usd: '53', gbp: '40', alloc_type: 'order', alloc_target: 'PO-030', alloc_part: 'balance', alloc_usd: '53', alloc_rmb: '370', alloc_description: '' }), { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 303);
  assert.equal(db.prepare('SELECT payment_id FROM wise_transfers WHERE id = ?').get('777').payment_id, 'P-2026-03-10');
});

test('“Get it from QuickBooks” fills in the rate on a payment that needs one', async () => {
  assert.match(await page('/payments/P-NEEDS-RATE'), /needs a QB rate/);
  const r = await post('/payments/P-NEEDS-RATE/qb-rate', '', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 303);
  assert.equal(loadLedger(db).payments.find((p) => p.id === 'P-NEEDS-RATE').qbRate, '0.79');
});

test('with QuickBooks connected, a payment can be saved without the rate; it shows as needing one', async () => {
  const body = formOf({ date: '2026-04-05', reference: 'PO-030 balance', usd: '60', alloc_type: 'order', alloc_target: 'PO-030', alloc_part: 'balance', alloc_usd: '60', alloc_rmb: '420', alloc_description: '' });
  const r = await post('/payments', body, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 303);
  assert.match(await page('/payments/P-2026-04-05'), /needs a QB rate/);
});
