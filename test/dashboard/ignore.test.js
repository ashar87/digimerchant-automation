// Ignoring a shipment with no PO: removed, its cards cleared, and the sync skips it. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger, getSetting } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';
import { enqueue, getCard } from '../../src/notify/outbox.js';
import { recordedSpApi } from '../../src/amazon/recorded.js';
import { syncAmazon } from '../../src/amazon/sync.js';

async function withDashboard(db, fn) {
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({
      page: async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Ashar' } })).text(),
      post: (p, fields) => fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams(fields), headers: { Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } }),
    });
  } finally {
    server.close();
  }
}

function setup() {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', sku: 'SKU-A' }],
    orders: [{ po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [] }],
    shipments: [
      { id: 'FBA-OLD', marketplace: 'UK', status: 'CLOSED', items: [{ product: 'A-UK', shipped: 50, received: 50 }] },
      { id: 'FBA-LINKED', marketplace: 'UK', status: 'CLOSED', items: [{ product: 'A-UK', po: 'PO-001', shipped: 10, received: 10 }] },
    ],
  }, { actor: 'test' });
  return db;
}

test('an unlinked shipment can be ignored from the Inbox: removed, its question closed, and the sync skips it', async () => {
  const db = setup();
  const card = enqueue(db, { kind: 'link_request', text: '🔗 New shipment FBA-OLD (UK)\n50 × A\nNo open order matches.\nReply Y', payload: { shipment: 'FBA-OLD' }, needsReply: true });
  db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), card);
  const unsentCard = enqueue(db, { kind: 'shipment_closed', dedupeKey: 'closed:FBA-OLD', text: '📦 FBA-OLD closed' });

  await withDashboard(db, async ({ page, post }) => {
    const inbox = await page('/');
    assert.match(inbox, /action="\/shipments\/FBA-OLD\/ignore"/);
    const version = inbox.match(/action="\/shipments\/FBA-OLD\/ignore"><input type="hidden" name="back" value="\/"><input type="hidden" name="version" value="([0-9a-f]+)"/)[1];
    const res = await post('/shipments/FBA-OLD/ignore', { back: '/', version });
    assert.equal(res.status, 303);
    assert.match(decodeURIComponent(res.headers.get('location')), /^\/\?ok=FBA-OLD ignored/);
  });
  assert.equal(loadLedger(db).shipments.find((s) => s.id === 'FBA-OLD'), undefined);
  assert.equal(getSetting(db, 'amazon_ignored_shipments'), 'FBA-OLD');
  assert.equal(getCard(db, card).reply, 'IGNORED');
  assert.equal(getCard(db, unsentCard), undefined);

  const client = recordedSpApi({ shipments: { UK: [{ ShipmentId: 'FBA-OLD', ShipmentStatus: 'CLOSED' }] }, items: { 'FBA-OLD': [{ SellerSKU: 'SKU-A', QuantityShipped: 50, QuantityReceived: 50 }] } });
  const report = await syncAmazon({ db, client, now: new Date('2026-10-11T08:00:00Z') });
  assert.deepEqual(report.created, []);
});

test('a shipment linked to a PO cannot be ignored, and has no Ignore button', async () => {
  const db = setup();
  await withDashboard(db, async ({ page, post }) => {
    const form = await page('/shipments/FBA-LINKED');
    assert.doesNotMatch(form, /Ignore this shipment/);
    assert.match(await page('/shipments/FBA-OLD'), /Ignore this shipment/);
    const version = form.match(/name="version" value="([0-9a-f]+)"/)[1];
    const res = await post('/shipments/FBA-LINKED/ignore', { version });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /linked to PO-001/);
  });
  assert.ok(loadLedger(db).shipments.find((s) => s.id === 'FBA-LINKED'));
});
