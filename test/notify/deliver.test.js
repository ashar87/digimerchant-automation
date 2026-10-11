// Queued dashboard cards reach WhatsApp: questions one by one, updates as one digest. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb } from '../../src/landing/store.js';
import { enqueue, getCard, unsent } from '../../src/notify/outbox.js';
import { deliverOutbox, parseCardAnswer, withAnswerLine } from '../../src/notify/deliver.js';

function queue(db) {
  enqueue(db, { kind: 'shipment_closed', text: '📦 FBA1 closed (UK)\n100 of 100 A received.' });
  const q = enqueue(db, { kind: 'link_request', text: '🔗 New shipment FBA2 (UK)\n50 × A\nMatches PO-001.\nReply Y to link, N to choose another on the dashboard.', payload: { action: 'link', shipment: 'FBA2' }, needsReply: true });
  enqueue(db, { kind: 'shortfall', text: '⚠️ FBA1 closed (UK)\n90 of 100 B received, 10 short.' });
  return q;
}

test('updates go as one digest and each question on its own, with its number', async () => {
  const db = openLandingDb(':memory:');
  const q = queue(db);
  const sent = [];
  const n = await deliverOutbox(db, async (text) => (sent.push(text), { key: `k${sent.length}` }));
  assert.equal(n, 3);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /^🗒️ 2 updates from the dashboard\n\n📦 FBA1 closed[\s\S]*⚠️ FBA1 closed/);
  assert.match(sent[1], /^🔗 New shipment FBA2/);
  assert.match(sent[1], new RegExp(`Reply \\*Y #${q}\\* or \\*N #${q}\\*`));
  assert.doesNotMatch(sent[1], /Reply Y to link/);
  assert.equal(getCard(db, q).wa_message_id, 'k2'); // so a quoted reply finds it
  assert.equal(unsent(db).length, 0);
  assert.equal(await deliverOutbox(db, async () => assert.fail('nothing left to send')), 0);
});

test('a dry run (send returns null) leaves everything queued, and a failed send is retried next round', async () => {
  const db = openLandingDb(':memory:');
  queue(db);
  assert.equal(await deliverOutbox(db, async () => null), 0);
  assert.equal(unsent(db).length, 3);
  await assert.rejects(deliverOutbox(db, async () => { throw new Error('WhatsApp offline'); }));
  assert.equal(unsent(db).length, 3);
});

test('answers by number are understood; anything else is not', () => {
  assert.deepEqual(parseCardAnswer('Y #12'), { id: 12, verb: 'Y' });
  assert.deepEqual(parseCardAnswer('no#7'), { id: 7, verb: 'N' });
  assert.deepEqual(parseCardAnswer(' #30 yes '), { id: 30, verb: 'Y' });
  assert.equal(parseCardAnswer('Y A12'), null);
  assert.equal(parseCardAnswer('Y 12'), null);
  assert.equal(parseCardAnswer('maybe #12'), null);
});

test('a card without the generic reply line still gets the numbered one', () => {
  assert.match(withAnswerLine({ id: 4, text: '✂️ FBA3 carries A from PO-1 and PO-2.' }), /✂️ FBA3[\s\S]*\nReply \*Y #4\*/);
});
