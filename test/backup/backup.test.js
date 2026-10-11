// The nightly backup to Backblaze B2, against a pretend B2. Throwaway folders, made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';
import { decryptFile } from '../../src/landing/backup.js';
import { runBackup, lastBackup, backupItems } from '../../src/backup/run.js';
import { createB2 } from '../../src/backup/b2.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));

/** A bucket in memory, behind the same calls the B2 client makes. */
function fakeB2Fetch(bucket = 'dm-backups') {
  const files = new Map();
  let n = 0;
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (url, { method, headers, body }) => {
    calls.push(url.replace(/^https:\/\/[^/]+/, ''));
    if (url.endsWith('/b2_authorize_account')) {
      assert.match(headers.Authorization, /^Basic /);
      return json({ accountId: 'acc', apiUrl: 'https://api.example', downloadUrl: 'https://dl.example', authorizationToken: 'tok', allowed: { bucketId: 'b1', bucketName: bucket } });
    }
    if (url.endsWith('/b2_get_upload_url')) return json({ uploadUrl: 'https://up.example/upload', authorizationToken: 'up-tok' });
    if (url === 'https://up.example/upload') {
      const name = decodeURIComponent(headers['X-Bz-File-Name']);
      files.set(name, { id: `f${++n}`, data: Buffer.from(body) });
      return json({ fileName: name });
    }
    if (url.endsWith('/b2_list_file_names')) {
      const { prefix } = JSON.parse(body);
      return json({ files: [...files].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => ({ fileName: k, fileId: v.id, contentLength: v.data.length })), nextFileName: null });
    }
    if (url.endsWith('/b2_delete_file_version')) {
      files.delete(JSON.parse(body).fileName);
      return json({});
    }
    const dl = url.match(/^https:\/\/dl\.example\/file\/[^/]+\/(.+)$/);
    if (dl) {
      const f = files.get(dl[1].split('/').map(decodeURIComponent).join('/'));
      return f ? { ok: true, status: 200, arrayBuffer: async () => f.data } : json({ message: 'not found' }, 404);
    }
    return json({ message: `unexpected ${url}` }, 400);
  };
  return { fetch, files, calls };
}

test('a backup sends an encrypted snapshot and each document once, keeps 30, and the copy restores', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, { products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }], orders: [{ po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [] }] }, { actor: 'test' });
  const docs = tmp();
  fs.writeFileSync(path.join(docs, 'abc.pdf'), '%PDF secret invoice');
  const remote = fakeB2Fetch();
  const b2 = createB2({ keyId: 'k', appKey: 'secret', bucket: 'dm-backups', fetch: remote.fetch });
  const localDir = tmp();
  const run = (iso) => runBackup({ db, passphrase: 'correct horse battery staple', localDir, keep: 2, b2, folders: { files: docs }, now: new Date(iso) });

  const first = await run('2026-10-11T01:30:00Z');
  assert.equal(first.ok, true);
  assert.deepEqual([...remote.files.keys()].sort(), ['db/landing-2026-10-11-01-30.db.enc', 'files/abc.pdf.enc']);
  assert.ok(!remote.files.get('files/abc.pdf.enc').data.includes('secret invoice')); // encrypted before it leaves

  await run('2026-10-12T01:30:00Z');
  const third = await run('2026-10-13T01:30:00Z');
  assert.equal(third.uploaded, 1); // just the snapshot: the document was already there
  assert.equal(third.pruned, 1);
  assert.deepEqual([...remote.files.keys()].filter((k) => k.startsWith('db/')).sort(), ['db/landing-2026-10-12-01-30.db.enc', 'db/landing-2026-10-13-01-30.db.enc']);
  assert.equal(fs.readdirSync(localDir).length, 2);

  // Bring the newest copy back and open it.
  const enc = path.join(tmp(), 's.enc');
  fs.writeFileSync(enc, await b2.download('db/landing-2026-10-13-01-30.db.enc'));
  const out = path.join(tmp(), 'restored.db');
  decryptFile(enc, out, 'correct horse battery staple');
  assert.equal(new Database(out, { readonly: true }).prepare('SELECT po FROM orders').get().po, 'PO-001');
  assert.throws(() => decryptFile(enc, path.join(tmp(), 'x.db'), 'wrong passphrase'), /Wrong passphrase/);
  assert.deepEqual(lastBackup(db).ok, true);
});

test('a key for a different bucket is refused, and a failed backup is recorded', async () => {
  const db = openLandingDb(':memory:');
  const b2 = createB2({ keyId: 'k', appKey: 's', bucket: 'other', fetch: fakeB2Fetch('dm-backups').fetch });
  await assert.rejects(runBackup({ db, passphrase: 'p', localDir: tmp(), b2, now: new Date('2026-10-11T01:30:00Z') }), /only opens bucket "dm-backups"/);
  assert.equal(lastBackup(db).ok, false);
  assert.match(backupItems(lastBackup(db))[0].title, /failed: This Backblaze key only opens bucket/);
});

test('the Inbox says when there is no backup, an old one, or one kept on the server only', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.match(backupItems(null, { now })[0].title, /No backup has run yet/);
  assert.deepEqual(backupItems(null, { now, configured: false }), []);
  assert.match(backupItems({ at: '2026-10-11T01:30:00Z', ok: true, offsite: true }, { now })[0].title, /No backup since/);
  assert.match(backupItems({ at: '2026-10-13T01:30:00Z', ok: true, offsite: false }, { now })[0].title, /on the server only/);
  assert.deepEqual(backupItems({ at: '2026-10-13T01:30:00Z', ok: true, offsite: true }, { now }), []);
});
