import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';
import { recordedSpApi } from '../../src/amazon/recorded.js';

let db, server, base, spapi;

before(async () => {
  db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'B-UK', code: 'B', marketplace: 'UK', name: 'Leaf B', fnsku: 'X00B' }],
    orders: [{ po: 'PO-002', supplier: 'Supplier Two', marketplace: 'UK', invoices: [{ id: 'i2', kind: 'final', date: '2026-01-02', lines: [{ kind: 'goods', product: 'B-UK', qty: 500, rmb: 5000 }] }] }],
    payments: [],
    courierBills: [],
    shipments: [],
  }, { actor: 'test' });
  spapi = recordedSpApi({
    shipments: { UK: [{ ShipmentId: 'FBA9', ShipmentName: 'FBA STA', ShipmentStatus: 'SHIPPED' }] },
    items: { FBA9: [{ SellerSKU: 'S', FulfillmentNetworkSKU: 'X00B', QuantityShipped: 500, QuantityReceived: 0 }, { SellerSKU: 'NEW-SKU', QuantityShipped: 5, QuantityReceived: 0 }] },
    inbound: { FBA9: { inboundPlanId: 'wf', shipmentId: 'sh', name: 'FBA STA' } },
  });
  server = createDashboard({ db, spapi });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const headers = { Cookie: 'actor=Ashar', Origin: 'x', 'Content-Type': 'application/x-www-form-urlencoded' };
const page = async (path) => (await fetch(base + path, { headers: { Cookie: 'actor=Ashar' } })).text();
const post = (path, body = '') => fetch(base + path, { method: 'POST', body, redirect: 'manual', headers: { ...headers, Origin: base } });

test('“Check now” syncs, and the Inbox offers the link and flags the unknown SKU', async () => {
  const r = await post('/amazon/sync');
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /1 new/);
  const inbox = await page('/');
  assert.match(inbox, /New shipment FBA9 \(UK\)/);
  assert.match(inbox, /Matches PO-002/);
  assert.match(inbox, /SKU NEW-SKU/);
  assert.match(await page('/messages'), /waiting for Y\/N/);
  assert.match(await page('/shipments'), /Last checked with Amazon/);
});

test('“Link” on the Inbox card links the shipment and renames it on Amazon', async () => {
  const id = db.prepare("SELECT id FROM outbox WHERE kind = 'link_request'").get().id;
  const r = await post(`/cards/${id}/reply`, 'reply=Y');
  assert.equal(r.status, 303);
  const s = loadLedger(db).shipments.find((x) => x.id === 'FBA9');
  assert.equal(s.items.find((i) => i.product === 'B-UK').po, 'PO-002');
  assert.equal(s.name, 'PO-002 FBA STA');
  assert.doesNotMatch(await page('/'), /Matches PO-002/);
});
