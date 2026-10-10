// Behind `tailscale serve`, Tailscale says who is signed in; nobody else gets in. Made-up logins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLandingDb } from '../../src/landing/store.js';
import { createDashboard, loadPeople } from '../../src/dashboard/server.js';
import { getTask } from '../../src/tasks/board.js';

let server, base, db;
const people = { 'ashar@example.com': 'Ashar', 'atif@example.com': 'Atif' };

before(async () => {
  db = openLandingDb(':memory:');
  server = createDashboard({ db, people });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
const as = (login) => ({ 'Tailscale-User-Login': login });

test('a signed-in partner gets in under their own name, without picking it', async () => {
  const res = await get('/tasks', as('Atif@Example.com'));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /class="who" href="\/who">Atif</);
  assert.equal((await get('/who', as('ashar@example.com'))).headers.get('location'), '/');
});

test('no Tailscale sign-in, or someone else, is refused, and a name cookie does not help', async () => {
  const none = await get('/', { Cookie: 'actor=Ashar' });
  assert.equal(none.status, 403);
  assert.match(await none.text(), /through its Tailscale link/);
  const stranger = await get('/', { ...as('rafay@example.com'), Cookie: 'actor=Ashar' });
  assert.equal(stranger.status, 403);
  assert.match(await stranger.text(), /rafay@example.com isn&#39;t allowed/);
});

test('changes are recorded under the Tailscale name', async () => {
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ title: 'Check the carton labels', assignee: 'Ashar', status: 'new' }),
    headers: { ...as('atif@example.com'), Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.status, 303);
  assert.equal(getTask(db, 'A1').createdBy, 'Atif');
});

test('people.json must map logins to known names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-'));
  const file = path.join(dir, 'people.json');
  fs.writeFileSync(file, JSON.stringify({ ' Ashar@Example.com ': 'Ashar' }));
  assert.deepEqual(loadPeople(file), { 'ashar@example.com': 'Ashar' });
  fs.writeFileSync(file, JSON.stringify({ 'rafay@example.com': 'Rafay' }));
  assert.throws(() => loadPeople(file), /isn't one of/);
  assert.throws(() => loadPeople(path.join(dir, 'missing.json')), /needs/);
});
