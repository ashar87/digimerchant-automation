// Amazon sync against recorded responses. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { recordedSpApi } from '../../src/amazon/recorded.js';
import { syncAmazon } from '../../src/amazon/sync.js';
import { applyCardReply } from '../../src/amazon/links.js';
import { unsent, awaitingReply } from '../../src/notify/outbox.js';

function setup() {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [
      { id: 'A-UK', code: 'A', marketplace: 'UK', name: 'Leaf A', sku: 'SKU-A' },
      { id: 'B-UK', code: 'B', marketplace: 'UK', name: 'Leaf B', fnsku: 'X00B' },
    ],
    orders: [
      { po: 'PO-001', supplier: 'Supplier One', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', date: '2026-01-01', lines: [{ kind: 'goods', product: 'A-UK', qty: 1000, rmb: 10000 }] }] },
      { po: 'PO-002', supplier: 'Supplier Two', marketplace: 'UK', invoices: [{ id: 'i2', kind: 'final', date: '2026-01-02', lines: [{ kind: 'goods', product: 'B-UK', qty: 500, rmb: 5000 }] }] },
    ],
    payments: [
      { id: 'P1', date: '2026-01-05', gbp: 1000, allocations: [{ type: 'order', target: 'PO-001', part: 'full' }] },
      { id: 'P2', date: '2026-01-06', gbp: 500, allocations: [{ type: 'order', target: 'PO-002', part: 'full' }] },
      { id: 'P3', date: '2026-02-01', gbp: 100, allocations: [{ type: 'bill', target: 'BILL1' }] },
    ],
    courierBills: [{ id: 'BILL1', lines: [{ kind: 'shipping', shipment: 'FBA1', rmb: 1 }] }],
    shipments: [{ id: 'FBA1', marketplace: 'UK', status: 'SHIPPED', createdAt: '2026-01-20', items: [{ product: 'A-UK', po: 'PO-001', shipped: 1000 }] }],
  }, { actor: 'test' });
  return db;
}

const shipment = (id, status, name = '') => ({ ShipmentId: id, ShipmentName: name, ShipmentStatus: status });
const item = (sku, shipped, received, fnsku) => ({ SellerSKU: sku, FulfillmentNetworkSKU: fnsku, QuantityShipped: shipped, QuantityReceived: received });

test('a closing shipment gets its counts, a cost update, a closed card and a shortfall card', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA1', 'CLOSED', 'PO-001 UK')] }, items: { FBA1: [item('SKU-A', 1000, 960)] } });
  const report = await syncAmazon({ db, client, now: new Date('2026-03-01T07:00:00Z') });

  assert.deepEqual(report.updated, ['FBA1']);
  const s = loadLedger(db).shipments.find((x) => x.id === 'FBA1');
  assert.equal(s.status, 'CLOSED');
  assert.equal(s.items[0].received, '960');
  assert.equal(s.items[0].po, 'PO-001'); // the link made by hand is kept
  assert.equal(s.firstReceivedAt, '2026-03-01');

  const cards = unsent(db);
  const closed = cards.find((c) => c.kind === 'shipment_closed');
  assert.match(closed.text, /FBA1 closed \(UK\)/);
  assert.match(closed.text, /960 of 1,000 A received, 40 short/);
  assert.match(closed.text, /Product cost £1\.0000 → £1\.0417/);
  assert.match(cards.find((c) => c.kind === 'shortfall').text, /40 short, about £42 at cost/);

  // Running again changes nothing and queues nothing new.
  const again = await syncAmazon({ db, client, now: new Date('2026-03-02T07:00:00Z') });
  assert.equal(again.cards, 0);
});

test('small count differences are absorbed without a shortfall card', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA1', 'CLOSED')] }, items: { FBA1: [item('SKU-A', 1000, 997)] } });
  await syncAmazon({ db, client });
  assert.ok(!unsent(db).some((c) => c.kind === 'shortfall'));
});

test('a new shipment named with its PO links itself', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA2', 'WORKING', 'PO-002 UK')] }, items: { FBA2: [item('ANY', 500, 0, 'X00B')] } });
  const report = await syncAmazon({ db, client });
  assert.deepEqual(report.created, ['FBA2']);
  assert.deepEqual(report.linked, ['FBA2']);
  const s = loadLedger(db).shipments.find((x) => x.id === 'FBA2');
  assert.deepEqual(s.items, [{ product: 'B-UK', po: 'PO-002', shipped: '500', received: '0' }]);
  assert.equal(awaitingReply(db).length, 0);
});

test('an unnamed shipment asks to link to the one order that fits; Y links it and renames it on Amazon', async () => {
  const db = setup();
  const client = recordedSpApi({
    shipments: { UK: [shipment('FBA3', 'SHIPPED', 'FBA STA (01/03/26)')] },
    items: { FBA3: [item('ANY', 495, 0, 'X00B')] },
    inbound: { FBA3: { inboundPlanId: 'wf1', shipmentId: 'sh9', name: 'FBA STA (01/03/26)' } },
  });
  await syncAmazon({ db, client });
  const [card] = awaitingReply(db);
  assert.match(card.text, /New shipment FBA3 \(UK\)\n495 × Leaf B\nMatches PO-002 \(Supplier Two, 500 open\)/);

  const out = await applyCardReply(db, card.id, 'y', { actor: 'Ashar', client });
  assert.equal(out.linked, 1);
  const s = loadLedger(db).shipments.find((x) => x.id === 'FBA3');
  assert.equal(s.items[0].po, 'PO-002');
  assert.equal(s.name, 'PO-002 FBA STA (01/03/26)');
  assert.deepEqual(client.calls.at(-1), ['updateShipmentName', 'UK', 'sh9', 'PO-002 FBA STA (01/03/26)']);
  assert.match((await applyCardReply(db, card.id, 'Y', { actor: 'Atif' })).message, /Already answered/);
});

test('N leaves the shipment unlinked', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA3', 'SHIPPED')] }, items: { FBA3: [item('ANY', 495, 0, 'X00B')] } });
  await syncAmazon({ db, client });
  const [card] = awaitingReply(db);
  await applyCardReply(db, card.id, 'N', { actor: 'Ashar' });
  assert.equal(loadLedger(db).shipments.find((x) => x.id === 'FBA3').items[0].po, undefined);
});

test('a SKU that isn’t in the product list is reported, not guessed', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA4', 'WORKING')] }, items: { FBA4: [item('MYSTERY', 10, 0, 'X00Z')] } });
  const report = await syncAmazon({ db, client });
  assert.deepEqual(report.unmapped, ['FBA4 MYSTERY']);
  assert.equal(db.prepare('SELECT sku FROM amazon_unmapped').get().sku, 'MYSTERY');
});

test('a landing cost moving more than 2% after a sync gets a card; the first sighting doesn’t', async () => {
  const db = setup();
  // First sync records the cost silently.
  await syncAmazon({ db, client: recordedSpApi({ shipments: { UK: [shipment('FBA1', 'RECEIVING')] }, items: { FBA1: [item('SKU-A', 1000, 500)] } }) });
  assert.ok(!unsent(db).some((c) => c.kind === 'cost_change'));
  // A hand edit elsewhere (a corrected payment) moves the cost 10%; the next sync reports it.
  const ledger = loadLedger(db);
  ledger.payments[0].gbp = '1100';
  saveLedger(db, { payments: [ledger.payments[0]] }, { actor: 'test' });
  await syncAmazon({ db, client: recordedSpApi({ shipments: { UK: [shipment('FBA1', 'RECEIVING')] }, items: { FBA1: [item('SKU-A', 1000, 800)] } }) });
  const card = unsent(db).find((c) => c.kind === 'cost_change');
  assert.match(card.text, /A UK in FBA1: landing cost £1\.1000 → £1\.2000 \(\+9\.1%\)/);
});
