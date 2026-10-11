// The listener's health in the Inbox: offline, an expiring WhatsApp Web pin, a library update. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb } from '../src/landing/store.js';
import { readHealth, writeHealth, healthItems, newer } from '../src/health.js';

const now = Date.parse('2026-11-30T12:00:00Z');

test('health is merged as it is written, and never touches the audit log', () => {
  const db = openLandingDb(':memory:');
  writeHealth(db, { beatAt: '2026-11-30T11:59:00Z', version: 'v1' });
  writeHealth(db, { beatAt: '2026-11-30T12:00:00Z' });
  assert.deepEqual(readHealth(db), { beatAt: '2026-11-30T12:00:00Z', version: 'v1' });
  assert.equal(db.prepare('SELECT count(*) n FROM audit_log').get().n, 0);
});

test('a heartbeat older than 10 minutes means offline, and says why if a start got stuck', () => {
  assert.deepEqual(healthItems({ beatAt: '2026-11-30T11:55:00Z' }, { now }), []);
  const [off] = healthItems({ beatAt: '2026-11-30T11:00:00Z', stuck: { at: '2026-11-30T11:20:00Z', version: '2.3000.9', store: false } }, { now });
  assert.equal(off.tone, 'error');
  assert.ok(off.count);
  assert.match(off.title, /offline since 2026-11-30T11:00:00Z/);
  assert.match(off.title, /WhatsApp Web 2\.3000\.9 loads but the library can't connect to it \(store missing\)/);
  // A stuck start from before the last heartbeat is old news.
  const [old] = healthItems({ beatAt: '2026-11-30T11:00:00Z', stuck: { at: '2026-11-29T09:00:00Z', version: 'x' } }, { now });
  assert.doesNotMatch(old.title, /loads but/);
  assert.deepEqual(healthItems(null, { now }), []); // no listener on this machine: nothing to say
});

test('a pinned WhatsApp Web version warns two weeks before its expiry date', () => {
  const pin = (pinExpires) => healthItems({ beatAt: '2026-11-30T11:59:00Z' }, { now, pinned: '2.3000.1', pinExpires });
  assert.deepEqual(pin('2026-12-20'), []);
  assert.match(pin('2026-12-10')[0].title, /reaches in 10 days its expiry date \(2026-12-10\)/);
  assert.equal(pin('2026-11-29')[0].tone, 'error');
});

test('a newer whatsapp-web.js is flagged, firmly while pinned', () => {
  const health = { beatAt: '2026-11-30T11:59:00Z', lib: { installed: '1.34.7', latest: '1.35.0' } };
  const [pinned] = healthItems(health, { now, pinned: '2.3000.1' });
  assert.equal(pinned.tone, 'warning');
  assert.match(pinned.title, /whatsapp-web\.js 1\.35\.0 is out \(running 1\.34\.7\)\. Upgrade it and remove the WhatsApp Web pin/);
  assert.equal(healthItems(health, { now })[0].count, false);
  assert.deepEqual(healthItems({ ...health, lib: { installed: '1.35.0', latest: '1.35.0' } }, { now }), []);
  assert.ok(newer('1.34.10', '1.34.7'));
  assert.ok(!newer('1.34.7', '1.34.7'));
});
