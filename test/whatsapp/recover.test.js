// Missed voice notes are retried later; a hung WhatsApp Web download gives up in time. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverMissed, MAX_TRIES } from '../../src/whatsapp/recover.js';
import { downloadByHash, pageStuck } from '../../src/whatsapp/media.js';

/** The listener store's missed_media functions, in memory. */
function memoryStore(rows) {
  let next = 100;
  const all = rows.map((r, i) => ({ id: i + 1, attempts: 0, status: 'pending', reason: null, ...r }));
  return {
    all,
    pendingMissed: () => all.filter((r) => r.status === 'pending').map((r) => ({ ...r })),
    settleMissed: (id, status) => (all.find((r) => r.id === id).status = status),
    triedMissed: (id, reason) => Object.assign(all.find((r) => r.id === id), { reason }, { attempts: all.find((r) => r.id === id).attempts + 1 }),
    expandMissed: (row, hashes) => {
      all.splice(all.findIndex((r) => r.id === row.id), 1);
      for (const h of hashes) all.push({ ...row, id: next++, hash: h });
    },
  };
}

/** A page whose evaluate answers the two calls recovery makes: find voice notes, and download one. */
function fakePage({ notes = [], downloads = {} }) {
  return {
    evaluate: async (fn, ...args) => (args.length === 3 ? notes : downloads[args[0]] ?? { reason: 'not-loaded' }),
  };
}

const log = { info() {}, ok() {}, warn() {}, error() {} };

test('a search row finds the voice notes around its time; each is then downloaded, transcribed and handed on', async () => {
  const store = memoryStore([{ chat_id: 'g1@g.us', author: 'Rafay', ts: 1_760_280_060, hash: null }]);
  const page = fakePage({ notes: [{ hash: 'H1', t: 1_760_280_060 }, { hash: 'H2', t: 1_760_280_090 }], downloads: { H1: { data: 'AAA', mimetype: 'audio/ogg; codecs=opus' }, H2: { data: 'BBB', mimetype: 'audio/ogg' } } });
  const recovered = [];
  const pass = () => recoverMissed({ page, store, log, transcribe: async (a, id) => `note ${id} (${a.mime})`, onRecovered: async (row, text) => recovered.push([row.hash, text]), onGaveUp: async () => assert.fail('nothing should be given up') });
  assert.equal(await pass(), 2); // the search becomes two rows, tried in the same pass
  assert.deepEqual(store.all.map((r) => r.hash), ['H1', 'H2']);
  assert.deepEqual(recovered, [['H1', 'note H1 (audio/ogg)'], ['H2', 'note H2 (audio/ogg)']]);
  assert.deepEqual(store.all.map((r) => r.status), ['recovered', 'recovered']);
});

test(`a note that still won't download is given up after ${MAX_TRIES} tries, and reported`, async () => {
  const store = memoryStore([{ chat_id: 'g1@g.us', author: 'Rafay', ts: Math.floor(Date.now() / 1000), hash: 'H9' }]);
  const page = fakePage({ downloads: { H9: { reason: 'timeout', detail: 'stuck' } } });
  const gaveUp = [];
  for (let i = 0; i < MAX_TRIES; i++) await recoverMissed({ page, store, log, transcribe: async () => 'x', onRecovered: async () => assert.fail('not recovered'), onGaveUp: async (row) => gaveUp.push(row) });
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].attempts, MAX_TRIES);
  assert.equal(gaveUp[0].reason, 'timeout');
  assert.equal(store.all[0].status, 'given_up');
});

test('a download that never answers gives up at the time limit instead of hanging', async () => {
  const hung = { evaluate: () => new Promise(() => {}) };
  const started = Date.now();
  const r = await downloadByHash(hung, 'H1', { limitMs: 200 });
  assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - started < 1000);
  assert.ok(pageStuck(r));
  assert.ok(pageStuck({ reason: 'page-error', detail: 'Runtime.callFunctionOn timed out.' }));
  assert.ok(!pageStuck({ reason: 'not-ready', detail: 'stage FETCHING' }));
});
