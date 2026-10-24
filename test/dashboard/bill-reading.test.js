// Uploading a courier bill photo, checking the draft and saving it. A stand-in
// reader returns made-up rows; nothing is sent anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.INVOICE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bills-'));
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'files-'));
const { openLandingDb, saveLedger, loadLedger } = await import('../../src/landing/store.js');
const { createDashboard } = await import('../../src/dashboard/server.js');
const { listAttachments } = await import('../../src/files/attachments.js');
const { RAW } = await import('../bills/fixture.js');

test('a bill photo is read into a draft, checked, and saved as a courier bill with the photo attached', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-US', code: 'A', marketplace: 'US' }],
    shipments: [{ id: 'FBA99TEST0B1', marketplace: 'US', items: [{ product: 'A-US', shipped: 10 }] }, { id: 'FBA99TEST2C3', marketplace: 'US', items: [{ product: 'A-US', shipped: 10 }] }],
  }, { actor: 'test' });
  let sent = null;
  const billReader = { read: async (file) => ((sent = file), { ...RAW, model: 'stand-in' }) };
  const server = createDashboard({ db, billReader });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: 'actor=Ashar', Origin: base };
  const page = async (p) => (await fetch(base + p, { headers })).text();
  try {
    const upload = new FormData();
    upload.append('file', new Blob([Buffer.from('fake jpeg bytes')], { type: 'image/jpeg' }), 'WhatsApp Image 2026-10-02 at 15.17.29.jpeg');
    const res = await fetch(`${base}/bills/upload`, { method: 'POST', body: upload, redirect: 'manual', headers });
    assert.equal(res.status, 303);
    const draftUrl = res.headers.get('location');
    assert.match(draftUrl, /^\/bills\/drafts\/\d+$/);
    assert.equal(sent.mime, 'image/jpeg');

    const draft = await page(draftUrl);
    assert.match(draft, /Lines add up to the bill total, 1,920 RMB ✓/);
    assert.match(draft, /read as FBA99TESTZC3; taken as FBA99TEST2C3/);
    assert.match(draft, /name="date" value="2026-10-02"/); // from the file name
    assert.match(draft, /name="rmbPerUsd" inputmode="decimal" value="6.4"/);
    assert.match(await page('/'), /Courier bill to check: WhatsApp Image 2026-10-02/);

    // Save exactly what the draft form shows.
    const form = new URLSearchParams({ agent: 'Annie', date: '2026-10-02', statedTotalRmb: '1920', rmbPerUsd: '6.4' });
    for (const [kind, shipment, rmb, description] of [['shipping', 'FBA99TEST0B1', '1000', ''], ['domestic', 'FBA99TEST0B1', '50', ''], ['shipping', 'FBA99TEST2C3', '900', ''], ['domestic', 'FBA99TEST2C3', '50', ''], ['fee', '', '20', '1% of Annie service fee'], ['adjustment', '', '-100', 'Last time payment rate difference']]) {
      form.append('line_kind', kind); form.append('line_shipment', shipment); form.append('line_rmb', rmb); form.append('line_description', description);
    }
    const saved = await fetch(`${base}${draftUrl}/save`, { method: 'POST', body: form, redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(saved.status, 303);
    assert.match(saved.headers.get('location'), /^\/bills\/BILL-2026-10-02\?ok=/);
    const bill = loadLedger(db).courierBills.find((b) => b.id === 'BILL-2026-10-02');
    assert.equal(bill.lines.length, 6);
    assert.equal(listAttachments(db, 'courier_bill', 'BILL-2026-10-02')[0].filename, 'WhatsApp Image 2026-10-02 at 15.17.29.jpeg');
    assert.doesNotMatch(await page('/'), /Courier bill to check/);

    const again = await fetch(`${base}${draftUrl}/save`, { method: 'POST', body: form, redirect: 'manual', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(again.status, 400);
  } finally {
    server.close();
  }
});
