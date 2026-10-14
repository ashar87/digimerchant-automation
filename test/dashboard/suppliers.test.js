// The supplier dropdowns and the list behind them. In-memory database, made-up names.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { openLandingDb, saveLedger, getSetting } = await import('../../src/landing/store.js');
const { createDashboard } = await import('../../src/dashboard/server.js');

test('supplier dropdowns offer the suppliers on file until a list is saved in Settings', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [
      { po: 'PO-001', supplier: 'Beta Foils', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', supplier: 'Gamma Leaf', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }] },
      { po: 'PO-002', supplier: 'Alpha Gold', marketplace: 'UK', invoices: [] },
    ],
  }, { actor: 'test' });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = async (p) => (await fetch(base + p, { headers: { Cookie: 'actor=Ashar' } })).text();
  const options = (h, name) => [...h.match(new RegExp(`<select name="${name}"[^>]*>([\\s\\S]*?)</select>`))[1].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  try {
    assert.deepEqual(options(await page('/orders'), 'supplier'), ['', 'Alpha Gold', 'Beta Foils', 'Gamma Leaf']);

    const saved = await fetch(`${base}/settings/suppliers`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ suppliers: ' Alpha Gold \r\nDelta\n\nDelta\n' }), headers: { Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(saved.status, 303);
    assert.equal(getSetting(db, 'suppliers'), 'Alpha Gold\nDelta');
    assert.deepEqual(options(await page('/orders'), 'supplier'), ['', 'Alpha Gold', 'Delta']);

    // An order whose supplier is off the list keeps it as a choice, selected.
    const edit = await page('/orders/PO-001');
    assert.deepEqual(options(edit, 'supplier'), ['', 'Alpha Gold', 'Delta', 'Beta Foils']);
    assert.match(edit, /<option value="Beta Foils" selected>/);
    assert.deepEqual(options(edit, 'invoiceSupplier'), ['', 'Alpha Gold', 'Delta']);
    assert.match(await page('/settings'), /<textarea id="supplier-list" name="suppliers"[^>]*>Alpha Gold\nDelta<\/textarea>/);
  } finally {
    server.close();
  }
});
