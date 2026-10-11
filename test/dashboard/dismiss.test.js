// Dismissing an Inbox check that doesn't matter, and putting it back. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { computeLandingCosts } from '../../src/landing/engine.js';
import { createDashboard } from '../../src/dashboard/server.js';

test('a warning can be dismissed and put back; it returns by itself if the figures change', async () => {
  const db = openLandingDb(':memory:');
  const ledger = (rmb) => ({
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [{ po: 'PO-001', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 1000 }] }] }],
    payments: [{ id: 'P1', date: '2026-01-01', usd: 150, gbp: 120, allocations: [{ type: 'order', target: 'PO-001', part: 'full', usd: 150, rmb }] }],
  });
  saveLedger(db, ledger(1025), { actor: 'test' });
  const warning = computeLandingCosts(loadLedger(db)).issues.find((i) => i.severity === 'warning' && /PO-001/.test(i.message));
  assert.ok(warning, 'expected an overpayment warning to work with');

  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = async () => (await fetch(`${base}/`, { headers: { Cookie: 'actor=Ashar' } })).text();
  const post = (p, message) => fetch(base + p, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ message }), headers: { Cookie: 'actor=Ashar', Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' } });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&amp;');
  try {
    assert.match(await page(), new RegExp(`${esc(warning.message)}[\\s\\S]*?Dismiss</button>`));
    assert.equal((await post('/inbox/dismiss', warning.message)).status, 303);
    let inbox = await page();
    assert.match(inbox, /1 dismissed/);
    assert.match(inbox, /Dismissed by Ashar/);
    assert.equal((await post('/inbox/dismiss', 'no such check')).status, 400);

    assert.equal((await post('/inbox/restore', warning.message)).status, 303);
    assert.doesNotMatch(await page(), /dismissed<\/summary>/);

    // Dismiss again, then the figures change: the new wording is a new check.
    await post('/inbox/dismiss', warning.message);
    saveLedger(db, ledger(1050), { actor: 'test' });
    inbox = await page();
    assert.doesNotMatch(inbox, /dismissed<\/summary>/);
    assert.match(inbox, /PO-001[^<]*over by 50/);
  } finally {
    server.close();
  }
});
