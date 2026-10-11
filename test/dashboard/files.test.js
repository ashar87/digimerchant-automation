// Documents on orders, invoices and payments: attach, view, remove. Throwaway folders, made-up data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-'));
process.env.FILES_DIR = dir;
const { openLandingDb, saveLedger } = await import('../../src/landing/store.js');
const { createDashboard } = await import('../../src/dashboard/server.js');

let server, base, db;
before(async () => {
  db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [{ po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }] }],
    payments: [{ id: 'P1', date: '2026-01-01', usd: 10, gbp: 8, allocations: [{ type: 'order', target: 'PO-001', part: 'full', usd: 10 }] }],
  }, { actor: 'test' });
  server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const page = async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Atif' } })).text();
function attach(fields, files) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  for (const [name, content, type] of files) body.append('file', new Blob([content], { type }), name);
  return fetch(`${base}/files`, { method: 'POST', body, redirect: 'manual', headers: { Cookie: 'actor=Atif', Origin: base } });
}
const PDF = '%PDF-1.4 made-up invoice';

test('documents attach to an order, an invoice and a payment, and open in the browser', async () => {
  let res = await attach({ entity: 'order', entity_id: 'PO-001', back: '/orders/PO-001', note: 'packing list' }, [['packing list.pdf', PDF, 'application/pdf'], ['goods.jpg', 'jpegbytes', 'image/jpeg']]);
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get('location').replace(/\+/g, ' ')), /^\/orders\/PO-001\?ok=2 documents attached/);
  res = await attach({ entity: 'invoice', entity_id: 'i1', back: '/orders/PO-001' }, [['final invoice.pdf', PDF, 'application/pdf']]);
  assert.equal(res.status, 303);
  res = await attach({ entity: 'payment', entity_id: 'P1', back: '/payments/P1' }, [['wise receipt.pdf', 'receipt', 'application/pdf']]);
  assert.equal(res.status, 303);

  const order = await page('/orders/PO-001');
  assert.match(order, /packing list\.pdf<\/a> <span class="muted small">PDF · 1 KB · Atif, [^<]+ · packing list/);
  assert.match(order, /goods\.jpg/);
  assert.match(order, /final invoice\.pdf/);
  assert.match(await page('/payments/P1'), /<h2>Receipts<\/h2>[\s\S]*wise receipt\.pdf/);

  const id = order.match(/href="\/files\/(\d+)"[^>]*>packing list\.pdf/)[1];
  const file = await fetch(`${base}/files/${id}`, { headers: { Cookie: 'actor=Atif' } });
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^inline; filename="packing list\.pdf"/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await file.text(), PDF);
  assert.equal(fs.readdirSync(dir).length, 4 - 1); // the same PDF attached twice is stored once
});

test('only document types are accepted, never pages that could run here; spreadsheets download', async () => {
  const bad = await attach({ entity: 'order', entity_id: 'PO-001', back: '/orders/PO-001' }, [['evil.html', '<script>alert(1)</script>', 'application/pdf']]);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Attach a PDF, photo/);
  await attach({ entity: 'order', entity_id: 'PO-001', back: '/orders/PO-001' }, [['costs.xlsx', 'xlsx', 'text/html']]);
  const id = (await page('/orders/PO-001')).match(/href="\/files\/(\d+)"[^>]*>costs\.xlsx/)[1];
  const file = await fetch(`${base}/files/${id}`, { headers: { Cookie: 'actor=Atif' } });
  assert.match(file.headers.get('content-type'), /spreadsheetml/); // from the extension, not what the browser claimed
  assert.match(file.headers.get('content-disposition'), /^attachment;/);
});

test('nothing attaches to a record that does not exist, and an off-site back link is ignored', async () => {
  const res = await attach({ entity: 'payment', entity_id: 'P999', back: 'https://evil.example/' }, [['r.pdf', PDF, 'application/pdf']]);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no payment P999/);
});

test('removing asks first, records it, and deletes the file once nothing uses it', async () => {
  const order = await page('/orders/PO-001');
  const id = order.match(/href="\/files\/(\d+)"[^>]*>goods\.jpg/)[1];
  assert.match(await page(`/files/${id}/remove?back=/orders/PO-001`), /Remove goods\.jpg\?/);
  const before = fs.readdirSync(dir).length;
  const res = await fetch(`${base}/files/${id}/remove`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ back: '/orders/PO-001' }), headers: { Cookie: 'actor=Atif', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 303);
  assert.doesNotMatch(await page('/orders/PO-001'), /goods\.jpg/);
  assert.equal(fs.readdirSync(dir).length, before - 1);
  assert.equal((await fetch(`${base}/files/${id}`, { headers: { Cookie: 'actor=Atif' } })).status, 404);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'detach' AND entity_id = 'PO-001'").get());
});
