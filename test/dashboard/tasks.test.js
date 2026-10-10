// The task board: add, move, edit, filter, delete; refs carry on the WhatsApp A-series. Made-up data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';
import { refFor, refNumber, seedTaskRefs, nextTaskRef, saveTask, getTask } from '../../src/tasks/board.js';

let server, base, db;

before(async () => {
  db = openLandingDb(':memory:');
  saveLedger(db, { products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }], orders: [{ po: 'PO-001', supplier: 'Supplier', marketplace: 'UK', invoices: [] }] }, { actor: 'test' });
  seedTaskRefs(db, 19); // the WhatsApp listener has handed out A1…A19
  server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const page = async (p, actor = 'Ashar') => (await fetch(base + p, { headers: { Cookie: `actor=${actor}` } })).text();
const post = (path, fields, { actor = 'Ashar' } = {}) =>
  fetch(base + path, {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'manual',
    headers: { Cookie: `actor=${actor}`, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
const versionIn = (html) => html.match(/name="version" value="([0-9a-f]+)"/)[1];

test('refs follow the WhatsApp scheme: A1…A99, then B1', () => {
  assert.equal(refFor(1), 'A1');
  assert.equal(refFor(99), 'A99');
  assert.equal(refFor(100), 'B1');
  assert.equal(refNumber('B1'), 100);
  assert.equal(refNumber('a19'), 19);
  assert.equal(refNumber('PO-001'), 0);
});

test('a task added on the board takes the next A-number and lands in New', async () => {
  const res = await post('/tasks', { title: 'Chase the courier for PO-001', assignee: 'Atif', status: 'new', due: '2026-01-02', priority: 'high', po: 'PO-001', notes: '' });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get('location')), /A20 added/);
  const t = getTask(db, 'A20');
  assert.equal(t.assignee, 'Atif');
  assert.equal(t.createdBy, 'Ashar');
  assert.equal(t.source, 'manual');

  const board = await page('/tasks');
  assert.match(board, /Chase the courier for PO-001/);
  assert.match(board, /Overdue/); // due date long past
  assert.match(await page('/'), /1 overdue task: A20 Chase the courier/);
  assert.match(await page('/orders/PO-001'), /Tasks for this PO[\s\S]*Chase the courier/);
});

test('only Ashar and Atif can be assigned, and the title is required', async () => {
  assert.equal((await post('/tasks', { title: 'X', assignee: 'Rafay' })).status, 400);
  assert.equal((await post('/tasks', { title: ' ', assignee: 'Ashar' })).status, 400);
  assert.equal((await post('/tasks', { title: 'X', assignee: 'Ashar', po: 'PO-999' })).status, 400);
});

test('one tap moves a task along, and a stale page is refused', async () => {
  const t = saveTask(db, { ref: nextTaskRef(db), title: 'Book the inspection', status: 'new', assignee: 'Ashar' }, { actor: 'Atif' });
  assert.equal(t.ref, 'A21');
  const v1 = versionIn(await page(`/tasks/${t.ref}`));

  const start = await post(`/tasks/${t.ref}/move`, { status: 'in_progress', version: v1, back: '/tasks?assignee=Ashar' });
  assert.equal(start.status, 303);
  assert.match(start.headers.get('location'), /^\/tasks\?assignee=Ashar&ok=/);
  assert.equal(getTask(db, t.ref).status, 'in_progress');

  // Same page, opened before the move: refused, and says who moved it.
  const stale = await post(`/tasks/${t.ref}/move`, { status: 'done', version: v1 });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /You \(in another tab\) changed A21/);

  const done = await post(`/tasks/${t.ref}/move`, { status: 'done', version: versionIn(await page(`/tasks/${t.ref}`)), back: 'https://evil.example/' });
  assert.equal(done.headers.get('location').split('?')[0], '/tasks'); // never redirects off-site
  assert.ok(getTask(db, t.ref).doneAt);

  const reopen = await post(`/tasks/${t.ref}/move`, { status: 'new', version: versionIn(await page(`/tasks/${t.ref}`)) });
  assert.equal(reopen.status, 303);
  assert.equal(getTask(db, t.ref).doneAt, null);
});

test('editing records what changed, and WhatsApp tasks show where they came from', async () => {
  saveTask(db, { ref: nextTaskRef(db), title: 'Send the label photos', status: 'new', assignee: 'Atif', source: 'whatsapp', sourceChat: 'Supplier group', sourceQuote: 'please send label photos' }, { actor: 'Ashar' });
  const before = await page('/tasks/A22');
  assert.match(before, /From WhatsApp<\/b> · Supplier group/);
  assert.match(before, /please send label photos/);

  const res = await post('/tasks/A22', { version: versionIn(before), title: 'Send the label photos', assignee: 'Ashar', status: 'in_progress', due: '', priority: '', po: '', notes: 'by Friday' });
  assert.equal(res.status, 303);
  const after = await page('/tasks/A22');
  assert.match(after, /Status: New → In progress; Assigned to: Atif → Ashar; Notes changed/);
  assert.match(after, /Added from WhatsApp/);
  assert.equal(getTask(db, 'A22').source, 'whatsapp'); // editing never loses the source
});

test('filters live in the URL', async () => {
  const atif = await page('/tasks?assignee=Atif');
  assert.match(atif, /Chase the courier/);
  assert.doesNotMatch(atif, /Book the inspection/);
  assert.match(await page('/tasks?source=whatsapp'), /Send the label photos/);
  assert.doesNotMatch(await page('/tasks?source=whatsapp'), /Chase the courier/);
  assert.match(await page('/tasks?q=courier'), /Showing 1 of/);
  const overdue = await page('/tasks?overdue=1');
  assert.match(overdue, /Chase the courier/);
  assert.doesNotMatch(overdue, /Send the label photos/);
});

test('done tasks drop off after 14 days, behind "Show older"', async () => {
  const ref = nextTaskRef(db);
  saveTask(db, { ref, title: 'Old finished thing', status: 'done', assignee: 'Ashar', doneAt: '2020-01-01T00:00:00.000Z' }, { actor: 'Ashar' });
  const board = await page('/tasks');
  assert.doesNotMatch(board, /Old finished thing/);
  assert.match(board, /Show older \(1\)/);
  assert.match(await page('/tasks?older=1&col=done'), /Old finished thing/);
});

test('delete asks first, then removes the task', async () => {
  const confirm = await page('/tasks/A21/delete');
  assert.match(confirm, /Delete A21\?/);
  const res = await post('/tasks/A21/delete', { version: versionIn(confirm) });
  assert.equal(res.status, 303);
  assert.equal(getTask(db, 'A21'), undefined);
  assert.equal((await fetch(`${base}/tasks/A21`, { headers: { Cookie: 'actor=Ashar' } })).status, 404);
  // A deleted ref is never handed out again.
  assert.notEqual(nextTaskRef(db), 'A21');
});
