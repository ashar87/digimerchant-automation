// Clearing WhatsApp Web's cached app keeps the login. Throwaway folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearWebAppCache } from '../../src/whatsapp/session.js';

test('the cached app is removed, the login (IndexedDB, Local Storage) is kept', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  const profile = path.join(root, 'session', 'Default');
  for (const d of ['Service Worker/CacheStorage', 'Cache', 'Code Cache', 'IndexedDB', 'Local Storage']) {
    fs.mkdirSync(path.join(profile, d), { recursive: true });
    fs.writeFileSync(path.join(profile, d, 'x'), 'x');
  }
  assert.deepEqual(clearWebAppCache(root), ['Service Worker', 'Cache', 'Code Cache']);
  assert.deepEqual(fs.readdirSync(profile).sort(), ['IndexedDB', 'Local Storage']);
  assert.deepEqual(clearWebAppCache(root), []); // nothing left to clear
  assert.deepEqual(clearWebAppCache(path.join(root, 'missing')), []);
});
