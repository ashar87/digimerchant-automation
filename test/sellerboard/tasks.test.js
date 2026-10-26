// Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLandingCosts } from '../../src/landing/engine.js';
import { openLandingDb } from '../../src/landing/store.js';
import { refreshSellerboardTasks, sellerboardTasks, sellerboardTask, markSellerboardDone, recordEntered } from '../../src/sellerboard/tasks.js';
import { applyCardReply } from '../../src/amazon/links.js';
import { unsent, getCard, awaitingReply } from '../../src/notify/outbox.js';
import { deliverOutbox, withAnswerLine } from '../../src/notify/deliver.js';

const ledger = () => ({
  products: [{ id: 'A-UK', code: 'A', marketplace: 'UK', sku: 'SKU-A' }],
  orders: [{ po: 'PO-1', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 }] }] }],
  payments: [
    { id: 'P1', date: '2026-01-01', gbp: 100, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] },
    { id: 'P2', date: '2026-02-01', usd: 40, qbRate: '0.75', allocations: [{ type: 'bill', target: 'B1', usd: 40 }] },
  ],
  courierBills: [{ id: 'B1', lines: [{ kind: 'shipping', shipment: 'FBA-1', rmb: 300 }] }],
  shipments: [
    { id: 'FBA-1', marketplace: 'UK', status: 'SHIPPED', createdAt: '2026-01-10', items: [{ product: 'A-UK', po: 'PO-1', shipped: 100 }] },
    { id: 'FBA-OLD', marketplace: 'UK', status: 'CLOSED', createdAt: '2025-12-01', firstReceivedAt: '2025-12-05', sellerboardManual: true, items: [{ product: 'A-UK', shipped: 1, received: 1 }] },
  ],
});

const refresh = (db, l) => refreshSellerboardTasks(db, { ledger: l, result: computeLandingCosts(l), link: 'https://dash.example' });
const lands = (l) => Object.assign(l.shipments[0], { status: 'RECEIVING', firstReceivedAt: '2026-01-20' });
const closes = (l, received) => {
  l.shipments[0].status = 'CLOSED';
  l.shipments[0].items[0].received = received;
};

test('nothing to do until Amazon starts receiving; then one card with the figures to type in', () => {
  const db = openLandingDb(':memory:');
  const l = ledger();
  assert.equal(refresh(db, l), 0);
  assert.equal(sellerboardTasks(db).length, 0); // hand-typed FBA-OLD stays out too

  lands(l);
  assert.equal(refresh(db, l), 1);
  const [t] = sellerboardTasks(db);
  assert.deepEqual({ state: t.state, sku: t.sku, marketplace: t.marketplace, target: t.target }, { state: 'add', sku: 'SKU-A', marketplace: 'Amazon.co.uk', target: { date: '20/01/2026', units: 100, cost: '1.30' } });
  const [card] = unsent(db);
  assert.equal(card.text, '📥 Add to Sellerboard (UK + DE account)\nSKU-A · Amazon.co.uk · FBA-1\nBatch date 20/01/2026 · 100 units · £1.30\nhttps://dash.example/sellerboard');
  assert.match(withAnswerLine(card), /Reply \*Y #\d+\* once it’s in Sellerboard/);
  assert.equal(refresh(db, l), 0, 'no second card for the same batch');

  // The cost moves before it's added: a fresh card replaces the first.
  l.payments[0].gbp = 110;
  assert.equal(refresh(db, l), 1);
  assert.equal(getCard(db, card.id).reply, 'superseded');
  assert.match(unsent(db).at(-1).text, /£1\.40/);
});

test('Y on WhatsApp marks it done; still-counting changes wait; closing with a different cost or count asks for an update', async () => {
  const db = openLandingDb(':memory:');
  const l = ledger();
  lands(l);
  refresh(db, l);
  const [card] = unsent(db);
  const out = await applyCardReply(db, card.id, 'Y', { actor: 'Ashar' });
  assert.match(out.message, /Marked as in Sellerboard/);
  assert.equal(sellerboardTask(db, 'FBA-1', 'A-UK').state, 'done');
  assert.equal(awaitingReply(db).length, 0);

  // Still receiving: a new figure doesn't send anything yet.
  l.payments[0].gbp = 110;
  assert.equal(refresh(db, l), 0);
  const t = sellerboardTask(db, 'FBA-1', 'A-UK');
  assert.deepEqual({ state: t.state, cost: t.target.cost, entered: t.entered.cost }, { state: 'done', cost: '1.40', entered: '1.30' });

  // Closed 98 of 100: cost per unit and units both move.
  closes(l, 98);
  assert.equal(refresh(db, l), 1);
  const upd = unsent(db).at(-1);
  assert.equal(sellerboardTask(db, 'FBA-1', 'A-UK').state, 'update');
  assert.match(upd.text, /^✏️ Update Sellerboard \(UK \+ DE account\): FBA-1 closed/);
  assert.match(upd.text, /Cost £1\.30 → £1\.43/);
  assert.match(upd.text, /Units 100 → 98/);

  // A later move (a courier bill) replaces the update card with a new one.
  l.payments[1].usd = 60;
  l.payments[1].allocations[0].usd = 60;
  assert.equal(refresh(db, l), 1);
  assert.equal(getCard(db, upd.id).reply, 'superseded');
  assert.match((await applyCardReply(db, upd.id, 'Y', { actor: 'Ashar' })).message, /out of date/);

  // Done on the dashboard records the current figures and closes the card.
  const latest = unsent(db).at(-1);
  markSellerboardDone(db, { shipment: 'FBA-1', product: 'A-UK', actor: 'Ashar' });
  const done = sellerboardTask(db, 'FBA-1', 'A-UK');
  assert.deepEqual({ state: done.state, entered: done.entered }, { state: 'done', entered: done.target });
  assert.equal(getCard(db, latest.id).reply, 'Y');
  assert.equal(refresh(db, l), 0);
});

test('N leaves it on the list; a batch that drops out before it is added comes off', async () => {
  const db = openLandingDb(':memory:');
  const l = ledger();
  lands(l);
  refresh(db, l);
  const [card] = unsent(db);
  assert.match((await applyCardReply(db, card.id, 'N', { actor: 'Ashar' })).message, /Still on the Sellerboard list/);
  assert.equal(sellerboardTask(db, 'FBA-1', 'A-UK').state, 'add');

  l.shipments[0].sellerboardManual = true;
  refresh(db, l);
  assert.equal(sellerboardTasks(db).length, 0);
});

test('a card answered on the dashboard before it went out is not sent', async () => {
  const db = openLandingDb(':memory:');
  const l = ledger();
  lands(l);
  refresh(db, l);
  markSellerboardDone(db, { shipment: 'FBA-1', product: 'A-UK', actor: 'Ashar' });
  assert.equal(await deliverOutbox(db, async () => assert.fail('nothing to send')), 0);
  assert.equal(unsent(db).length, 0);
});

test('a batch typed in before the list existed is recorded without a card, and flagged when it closes', () => {
  const db = openLandingDb(':memory:');
  const l = ledger();
  lands(l);
  const result = computeLandingCosts(l);
  const t = recordEntered(db, { shipment: 'FBA-1', product: 'SKU-A', cost: '1.29', actor: 'Ashar', ledger: l, result });
  assert.deepEqual(t.entered, { date: '20/01/2026', units: 100, cost: '1.29' });
  assert.equal(unsent(db).length, 0);
  assert.equal(refresh(db, l), 0, 'still receiving');
  closes(l, 100);
  assert.equal(refresh(db, l), 1);
  assert.match(unsent(db)[0].text, /Cost £1\.29 → £1\.30/);
});
