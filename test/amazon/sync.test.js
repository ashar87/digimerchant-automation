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
  const report = await syncAmazon({ db, discover: true, client, now: new Date('2026-03-01T07:00:00Z') });

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
  const again = await syncAmazon({ db, discover: true, client, now: new Date('2026-03-02T07:00:00Z') });
  assert.equal(again.cards, 0);
});

test('small count differences are absorbed without a shortfall card', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA1', 'CLOSED')] }, items: { FBA1: [item('SKU-A', 1000, 997)] } });
  await syncAmazon({ db, discover: true, client });
  assert.ok(!unsent(db).some((c) => c.kind === 'shortfall'));
});

test('a new shipment named with its PO links itself', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA2', 'WORKING', 'PO-002 UK')] }, items: { FBA2: [item('ANY', 500, 0, 'X00B')] } });
  const report = await syncAmazon({ db, discover: true, client });
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
  await syncAmazon({ db, discover: true, client });
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
  await syncAmazon({ db, discover: true, client });
  const [card] = awaitingReply(db);
  await applyCardReply(db, card.id, 'N', { actor: 'Ashar' });
  assert.equal(loadLedger(db).shipments.find((x) => x.id === 'FBA3').items[0].po, undefined);
});

test('a SKU that isn’t in the product list is reported, not guessed', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA4', 'WORKING')] }, items: { FBA4: [item('MYSTERY', 10, 0, 'X00Z')] } });
  const report = await syncAmazon({ db, discover: true, client });
  assert.deepEqual(report.unmapped, ['FBA4 MYSTERY']);
  assert.equal(db.prepare('SELECT sku FROM amazon_unmapped').get().sku, 'MYSTERY');
});

test('a landing cost moving more than 2% after a sync gets a card; the first sighting doesn’t', async () => {
  const db = setup();
  // First sync records the cost silently.
  await syncAmazon({ db, discover: true, client: recordedSpApi({ shipments: { UK: [shipment('FBA1', 'RECEIVING')] }, items: { FBA1: [item('SKU-A', 1000, 500)] } }) });
  assert.ok(!unsent(db).some((c) => c.kind === 'cost_change'));
  // A hand edit elsewhere (a corrected payment) moves the cost 10%; the next sync reports it.
  const ledger = loadLedger(db);
  ledger.payments[0].gbp = '1100';
  saveLedger(db, { payments: [ledger.payments[0]] }, { actor: 'test' });
  await syncAmazon({ db, discover: true, client: recordedSpApi({ shipments: { UK: [shipment('FBA1', 'RECEIVING')] }, items: { FBA1: [item('SKU-A', 1000, 800)] } }) });
  const card = unsent(db).find((c) => c.kind === 'cost_change');
  assert.match(card.text, /A UK in FBA1: landing cost £1\.1000 → £1\.2000 \(\+9\.1%\)/);
});

test('a shipment named with two POs links each product to the order that has it', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA5', 'WORKING', 'PO-001 PO-002 UK')] }, items: { FBA5: [item('SKU-A', 300, 0), item('ANY', 200, 0, 'X00B')] } });
  const report = await syncAmazon({ db, discover: true, client });
  assert.deepEqual(report.linked, ['FBA5']);
  const s = loadLedger(db).shipments.find((x) => x.id === 'FBA5');
  assert.deepEqual(s.items.map((i) => [i.product, i.po]), [['A-UK', 'PO-001'], ['B-UK', 'PO-002']]);
  assert.equal(awaitingReply(db).length, 0);
});

test('when two named POs both have the product, it asks for a split instead of guessing', async () => {
  const db = setup();
  const l = loadLedger(db);
  l.orders[1].invoices[0].lines.push({ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 });
  saveLedger(db, { orders: [l.orders[1]] }, { actor: 'test' });
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA6', 'WORKING', 'po-001 / PO-002 UK')] }, items: { FBA6: [item('SKU-A', 300, 0), item('ANY', 200, 0, 'X00B')] } });
  await syncAmazon({ db, discover: true, client });
  const s = loadLedger(db).shipments.find((x) => x.id === 'FBA6');
  assert.deepEqual(s.items.map((i) => [i.product, i.po ?? null]), [['A-UK', null], ['B-UK', 'PO-002']]);
  const cards = unsent(db);
  assert.match(cards.find((c) => c.kind === 'split_needed').text, /carries Leaf A from PO-001 and PO-002/);
  assert.ok(!cards.some((c) => c.kind === 'link_request'));
});

test('a PO in the name that isn’t on file links nothing and asks instead', async () => {
  const db = setup();
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA7', 'WORKING', 'PO-999 UK')] }, items: { FBA7: [item('ANY', 495, 0, 'X00B')] } });
  await syncAmazon({ db, discover: true, client });
  assert.equal(loadLedger(db).shipments.find((x) => x.id === 'FBA7').items[0].po, undefined);
  assert.match(awaitingReply(db)[0].text, /Matches PO-002/);
});

test('European shipments are fetched once and filed under UK or DE by their warehouse', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, { products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', sku: 'SKU-A' }, { id: 'A-DE', code: 'A', marketplace: 'DE', sku: 'SKU-A' }] }, { actor: 'test' });
  const eu = [
    { ...shipment('FBA-UK', 'WORKING'), DestinationFulfillmentCenterId: 'LBA4' },
    { ...shipment('FBA-DE', 'WORKING'), DestinationFulfillmentCenterId: 'HAJ1' },
    { ...shipment('FBA-XX', 'WORKING'), DestinationFulfillmentCenterId: 'ZZZ9' },
  ];
  // Amazon returns every EU shipment whichever EU marketplace is asked about.
  const client = recordedSpApi({ shipments: { UK: eu, DE: eu }, items: { 'FBA-UK': [item('SKU-A', 10, 0)], 'FBA-DE': [item('SKU-A', 20, 0)], 'FBA-XX': [] } });
  const report = await syncAmazon({ db, discover: true, client, now: new Date('2026-10-10T08:00:00Z') });
  assert.deepEqual(report.created, ['FBA-UK', 'FBA-DE']);
  const shipments = loadLedger(db).shipments;
  assert.equal(shipments.find((s) => s.id === 'FBA-UK').marketplace, 'UK');
  assert.equal(shipments.find((s) => s.id === 'FBA-DE').marketplace, 'DE');
  assert.equal(shipments.find((s) => s.id === 'FBA-XX'), undefined);
  assert.match(report.errors.join(' '), /FBA-XX goes to Amazon warehouse ZZZ9/);
  assert.equal(client.calls.filter((c) => c[0] === 'getShipments').length, 1); // one query for the region, not one per marketplace
});

test('no shortfall card while Amazon lists SKUs that are not in the product list', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', sku: 'SKU-A' }, { id: 'B-UK', code: 'B', marketplace: 'UK' }],
    orders: [{ po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 }, { kind: 'goods', product: 'B-UK', qty: 300, rmb: 900 }] }] }],
    // B's line came from the sheet; Amazon calls it "OLD-B", which isn't mapped yet.
    shipments: [{ id: 'FBA9', marketplace: 'UK', status: 'RECEIVING', items: [{ product: 'A-UK', po: 'PO-001', shipped: 100, received: 0 }, { product: 'B-UK', po: 'PO-001', shipped: 300, received: 0 }] }],
  }, { actor: 'test' });
  const client = recordedSpApi({ shipments: { UK: [shipment('FBA9', 'CLOSED')] }, items: { FBA9: [item('SKU-A', 100, 100), item('OLD-B', 300, 300)] } });
  await syncAmazon({ db, discover: true, client, now: new Date('2026-10-10T08:00:00Z') });
  const kinds = unsent(db).map((c) => c.kind);
  assert.ok(kinds.includes('shipment_closed'));
  assert.ok(!kinds.includes('shortfall'), `unexpected shortfall card: ${kinds}`);
});

test('shipments set to ignore are skipped whole; the same SKU elsewhere still counts', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, { products: [{ id: 'A-US', code: 'A', marketplace: 'US', sku: 'SKU-A' }] }, { actor: 'test' });
  db.prepare("INSERT INTO settings (key, value) VALUES ('amazon_ignored_shipments', 'fba-r, FBA-OTHER')").run();
  const client = recordedSpApi({
    shipments: { US: [shipment('FBA-R', 'WORKING'), shipment('FBA-M', 'WORKING')] },
    items: { 'FBA-R': [item('SKU-A', 44, 0)], 'FBA-M': [item('SKU-A', 100, 0)] },
  });
  const report = await syncAmazon({ db, discover: true, client, now: new Date('2026-10-10T08:00:00Z') });
  assert.deepEqual(report.created, ['FBA-M']);
  assert.equal(loadLedger(db).shipments.find((s) => s.id === 'FBA-R'), undefined);
  assert.ok(!client.calls.some((c) => c[0] === 'getShipmentItems' && c[2] === 'FBA-R'));
});

test('a shipment cancelled before it was ever seen is not recorded; a known one that is cancelled is updated', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, { products: [{ id: 'A-US', code: 'A', marketplace: 'US', sku: 'SKU-A' }], shipments: [{ id: 'FBA-K', marketplace: 'US', status: 'WORKING', items: [{ product: 'A-US', shipped: 10 }] }] }, { actor: 'test' });
  const client = recordedSpApi({
    shipments: { US: [shipment('FBA-C', 'CANCELLED'), shipment('FBA-D', 'DELETED'), shipment('FBA-K', 'CANCELLED')] },
    items: { 'FBA-C': [item('SKU-A', 44, 0)], 'FBA-D': [item('SKU-A', 5, 0)], 'FBA-K': [item('SKU-A', 10, 0)] },
  });
  const report = await syncAmazon({ db, discover: true, client, now: new Date('2026-10-10T08:00:00Z') });
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.updated, ['FBA-K']);
  assert.equal(loadLedger(db).shipments.find((s) => s.id === 'FBA-K').status, 'CANCELLED');
  assert.ok(!unsent(db).some((c) => c.kind === 'link_request'));
});

test('by default only shipments already in the dashboard are updated; Amazon is asked about them by ID only', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', sku: 'SKU-A' }],
    orders: [{ po: 'PO-020', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i20', kind: 'proforma', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 }] }] }],
    // Added by hand with just its ID and name: the check fills in the rest.
    shipments: [{ id: 'FBA-MINE', marketplace: 'UK', name: 'PO-020 UK', status: 'WORKING', items: [] }],
  }, { actor: 'test' });
  const client = recordedSpApi({
    shipments: { UK: [shipment('FBA-MINE', 'RECEIVING', 'PO-020 UK'), shipment('FBA-OTHER', 'CLOSED')] },
    items: { 'FBA-MINE': [item('SKU-A', 100, 40)], 'FBA-OTHER': [item('SKU-A', 5, 5)] },
  });
  const report = await syncAmazon({ db, client, now: new Date('2026-10-12T06:00:00Z') });
  assert.deepEqual(report.created, []);
  assert.deepEqual(report.updated, ['FBA-MINE']);
  const mine = loadLedger(db).shipments.find((s) => s.id === 'FBA-MINE');
  assert.equal(mine.status, 'RECEIVING');
  assert.deepEqual(mine.items.map((i) => [i.product, i.po, i.shipped, i.received]), [['A-UK', 'PO-020', '100', '40']]);
  assert.equal(loadLedger(db).shipments.find((s) => s.id === 'FBA-OTHER'), undefined);
  assert.deepEqual(client.calls.filter((c) => c[0] === 'getShipments').map((c) => c[2]), ['ids']);
});

test('a product with no Seller SKU learns the one Amazon used for it (only when unambiguous)', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [
      { id: 'A-UK', code: 'A', marketplace: 'UK', fnsku: 'X00A' },
      { id: 'B-UK', code: 'B', marketplace: 'UK', fnsku: 'X00B' },
      { id: 'C-UK', code: 'C', marketplace: 'UK', sku: 'ALREADY', fnsku: 'X00C' },
    ],
    shipments: [{ id: 'FBA-L', marketplace: 'UK', status: 'WORKING', items: [] }],
  }, { actor: 'test' });
  const client = recordedSpApi({
    shipments: { UK: [shipment('FBA-L', 'WORKING')] },
    items: { 'FBA-L': [item('A-SKU', 10, 0, 'X00A'), item('B-ONE', 5, 0, 'X00B'), item('B-TWO', 5, 0, 'X00B'), item('C-NEW', 1, 0, 'X00C')] },
  });
  const report = await syncAmazon({ db, client, now: new Date('2026-10-13T06:00:00Z') });
  assert.deepEqual(report.learned, ['A-UK A-SKU']);
  const p = (id) => loadLedger(db).products.find((x) => x.id === id);
  assert.equal(p('A-UK').sku, 'A-SKU');
  assert.equal(p('B-UK').sku, undefined); // two SKUs: left for a person
  assert.equal(p('C-UK').sku, 'ALREADY'); // never overwritten
});
