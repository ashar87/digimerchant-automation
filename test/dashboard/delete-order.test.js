// Deleting a PO created by mistake. Throwaway folders, made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'files-'));
const { openLandingDb, saveLedger, loadLedger } = await import('../../src/landing/store.js');
const { createDashboard } = await import('../../src/dashboard/server.js');
const { addAttachment, listAttachments } = await import('../../src/files/attachments.js');
const { saveTask, getTask } = await import('../../src/tasks/board.js');

test('a PO is refused while a payment points at it, then deletes cleanly with its invoices and documents', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [
      { po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'proforma', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }], writeOffs: [{ product: 'A-UK', qty: 1, reason: 'damaged' }] },
    ],
    payments: [{ id: 'P1', date: '2026-01-01', reference: 'PO-001', gbp: 10, allocations: [{ type: 'order', target: 'PO-001', part: 'deposit', rmb: 30 }] }],
  }, { actor: 'test' });
  addAttachment(db, { entity: 'order', entityId: 'PO-001', buffer: Buffer.from('%PDF-1 order'), filename: 'packing.pdf', actor: 'Ashar' });
  addAttachment(db, { entity: 'invoice', entityId: 'i1', buffer: Buffer.from('%PDF-1 invoice'), filename: 'pi.pdf', actor: 'Ashar' });
  saveTask(db, { ref: 'A1', title: 'Chase PO-001', status: 'new', assignee: 'Atif', po: 'PO-001' }, { actor: 'Ashar' });

  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Ashar' } })).text();
  const del = async () => {
    const version = (await page('/orders/PO-001')).match(/action="\/orders\/PO-001\/delete" data-confirm="[^"]+"><input type="hidden" name="version" value="([0-9a-f]+)"/)[1];
    return fetch(`${base}/orders/PO-001/delete`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ version }), headers: { Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } });
  };
  try {
    assert.match(await page('/orders/PO-001'), /data-confirm="Delete PO-001 with its invoices, write-offs and documents\? This can't be undone\."/);
    const refused = await del();
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /PO-001 can&#39;t be deleted while payment P1 still points at it/);
    assert.ok(loadLedger(db).orders.find((o) => o.po === 'PO-001'));

    db.prepare("DELETE FROM payments WHERE id = 'P1'").run();
    const ok = await del();
    assert.equal(ok.status, 303);
    assert.match(decodeURIComponent(ok.headers.get('location')), /^\/orders\?ok=PO-001 deleted/);
    assert.equal(loadLedger(db).orders.find((o) => o.po === 'PO-001'), undefined);
    assert.equal(db.prepare('SELECT count(*) n FROM invoices').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM write_offs').get().n, 0);
    assert.deepEqual([...listAttachments(db, 'order', 'PO-001'), ...listAttachments(db, 'invoice', 'i1')], []);
    assert.equal(getTask(db, 'A1').po, null); // the task stays, unlinked
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'delete' AND entity = 'order' AND entity_id = 'PO-001'").get());
  } finally {
    server.close();
  }
});
