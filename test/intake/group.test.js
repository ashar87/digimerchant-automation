// Files from the supplier group: sorting, pages, corrected versions, Wise messages. Made-up figures only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-intake-'));
process.env.INVOICE_DIR = dir; // read when intake.js loads
const { openLandingDb, saveLedger } = await import('../../src/landing/store.js');
const { intakeGroupFiles, groupPages, createBursts } = await import('../../src/intake/group.js');
const { getDraft, draftFilePath } = await import('../../src/invoices/intake.js');
const { getBillDraft } = await import('../../src/bills/intake.js');
const { unsent } = await import('../../src/notify/outbox.js');
const { parseWiseMessage, noteWiseMessage, readWiseLink } = await import('../../src/wise/whatsapp.js');
const { paymentFromTransfer } = await import('../../src/wise/import.js');
const { whatsappName } = await import('../../src/intake/listener.js');
const { createDashboard } = await import('../../src/dashboard/server.js');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const photo = (tag) => ({ buffer: Buffer.from(`fake jpeg ${tag}`), filename: `WhatsApp Image 2026-10-28 at 10.00.0${tag.length}.jpeg`, mime: 'image/jpeg' });
// The labeller and readers see only the bytes; each fake photo says what it is.
const labels = { inv1: { kind: 'supplier_invoice', supplier: 'TEST LEAF CO., LTD.', invoiceNumber: 'PI-778' }, inv1p2: { kind: 'supplier_invoice' }, other: { kind: 'other' }, bill: { kind: 'courier_bill' } };
const tagOf = (data) => Buffer.from(data, 'base64').toString().replace('fake jpeg ', '');
const labeller = { label: async ({ data }) => labels[tagOf(data)] || labels[tagOf(data).replace(/v\d$/, '')] };
const invoiceReads = [];
const invoiceReader = {
  read: async ({ data, more = [] }) => {
    invoiceReads.push([tagOf(data), ...more.map((m) => tagOf(m.data))]);
    const total = tagOf(data).endsWith('v2') ? 1200 : 1000;
    return { supplier: 'TEST LEAF CO., LTD.', invoiceNumber: 'PI-778', date: '2026-10-28', currency: 'RMB', lines: [{ description: 'gold leaf 10pcs', quantity: 100, unitPrice: total / 100, amount: total }], total };
  },
};
const billReader = { read: async () => ({ agent: 'Annie', rows: [{ fbaId: 'FBA-T1', amount: 300 }], totalRmb: 300 }) };
const intake = (db, files, extra = {}) => intakeGroupFiles({ db, files, author: 'Atif', chatLabel: 'Supplier group', labeller, invoiceReader, billReader, dir, link: 'https://dash.example', ...extra });

const setup = () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'G-UK', code: 'G', marketplace: 'UK' }],
    shipments: [{ id: 'FBA-T1', marketplace: 'UK', status: 'SHIPPED', createdAt: '2026-10-20', items: [{ product: 'G-UK', shipped: 10 }] }],
  }, { actor: 'test' });
  return db;
};

test('pages sent together are one document; a new invoice number or another kind starts the next', () => {
  const f = (kind, extra = {}) => ({ mime: 'image/jpeg', label: { kind, ...extra } });
  const groups = groupPages([f('supplier_invoice', { invoiceNumber: 'A1' }), f('supplier_invoice'), f('supplier_invoice', { invoiceNumber: 'B2' }), f('courier_bill'), f('other')]);
  assert.deepEqual(groups.map((g) => [g.kind, g.files.length]), [['supplier_invoice', 2], ['supplier_invoice', 1], ['courier_bill', 1], ['other', 1]]);
});

test('an invoice in two photos becomes one draft read from both, with a card; other photos are left alone', async () => {
  const db = setup();
  invoiceReads.length = 0;
  const out = await intake(db, [photo('inv1'), photo('inv1p2'), photo('other')]);
  assert.deepEqual(out.map((o) => o.kind), ['invoice', 'other']);
  assert.deepEqual(invoiceReads, [['inv1', 'inv1p2']]);
  const draft = getDraft(db, out[0].draft.id);
  assert.equal(draft.source, 'whatsapp');
  assert.equal(draft.created_by, 'Atif');
  assert.equal(draft.reading.pages.length, 1);
  assert.ok(draftFilePath(draft, 1));
  const [card] = unsent(db);
  assert.match(card.text, /^🧾 Invoice from Atif in Supplier group \(2 pages\)\nTEST LEAF CO\., LTD\. · no\. PI-778\n1 line\(s\), total 1,000(\.00)? RMB/);
  assert.match(card.text, /Check and save: https:\/\/dash\.example\/invoices\/drafts\/\d+$/);
});

test('a corrected invoice sent later sets the waiting one aside; once saved, the next correction is lined up to replace it', async () => {
  const db = setup();
  const [first] = await intake(db, [photo('inv1')]);
  const [second] = await intake(db, [photo('inv1v2')]);
  assert.equal(getDraft(db, first.draft.id).status, 'discarded');
  assert.equal(getDraft(db, first.draft.id).replaced_by, second.draft.id);
  assert.deepEqual(getDraft(db, second.draft.id).reading.replaces, { draft: first.draft.id });
  assert.match(unsent(db).at(-1).text, /↻ A corrected version: the earlier one waiting to be checked \(invoice \d+\) is set aside\./);

  // Saved to PO-050 on the dashboard…
  saveLedger(db, { orders: [{ po: 'PO-050', supplier: 'Test Leaf', marketplace: 'UK', invoices: [{ id: 'PO-050-proforma-2026-10-28', kind: 'proforma', date: '2026-10-28', supplierRef: 'PI-778', series: 'PO-050-proforma-2026-10-28', lines: [{ kind: 'goods', product: 'G-UK', qty: 100, rmb: 1200 }] }] }] }, { actor: 'test' });
  db.prepare("UPDATE invoice_drafts SET status = 'saved', saved_as = 'PO-050-proforma-2026-10-28' WHERE id = ?").run(second.draft.id);
  // …then corrected again.
  const [third] = await intake(db, [photo('inv1v3')]);
  const d = getDraft(db, third.draft.id);
  assert.equal(d.status, 'pending');
  assert.equal(d.po, 'PO-050');
  assert.deepEqual(d.reading.replaces, { po: 'PO-050', invoiceId: 'PO-050-proforma-2026-10-28' });
  assert.match(unsent(db).at(-1).text, /A corrected version of PO-050’s invoice: saving it replaces that one\./);

  // The check page has "replaces invoice 1" already chosen.
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/invoices/drafts/${d.id}`, { headers: { Cookie: 'actor=Ashar' } })).text();
    assert.match(html, /Saving it replaces that one/);
    assert.match(html, /<option value="PO-050-proforma-2026-10-28" selected>replaces invoice 1/);
    assert.match(html, /from Atif on WhatsApp/);
  } finally {
    server.close();
  }
});

test('a courier bill becomes a bill draft; a corrected one for the same shipments sets it aside', async () => {
  const db = setup();
  const [a] = await intake(db, [photo('bill')]);
  assert.equal(a.kind, 'bill');
  const bill = getBillDraft(db, a.draft.id);
  assert.equal(bill.reading.date, '2026-10-28'); // from the WhatsApp-style name
  assert.match(unsent(db)[0].text, /^📦 Courier bill from Atif in Supplier group\n1 line\(s\), total 300(\.00)? RMB · FBA-T1/);
  const [b] = await intake(db, [photo('billv2')]);
  assert.equal(getBillDraft(db, a.draft.id).replaced_by, b.draft.id);
  assert.match(unsent(db).at(-1).text, /set aside/);
});

test('a reading that fails still leaves a card saying so', async () => {
  const db = setup();
  const out = await intake(db, [{ buffer: Buffer.from('x'), filename: 'notes.docx', mime: 'application/msword' }], { labeller: { label: async () => ({ kind: 'supplier_invoice' }) } });
  assert.ok(out[0].error);
  assert.match(unsent(db)[0].text, /^⚠️ Couldn’t take in an invoice from Atif/);
});

test('files are handed over once the sender has been quiet', async () => {
  const got = [];
  const b = createBursts({ idleMs: 20, onFlush: async (meta, files) => got.push([meta.author, files.length]) });
  b.add('g|Atif', { author: 'Atif' }, 1);
  b.add('g|Atif', { author: 'Atif' }, 2);
  b.add('g|Ashar', { author: 'Ashar' }, 3);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got.sort(), [['Ashar', 1], ['Atif', 2]]);
});

test('a Wise payment message becomes a transfer to record, with the GBP from the link when it shows it', async () => {
  assert.equal(parseWiseMessage('paid the balance'), null);
  const body = 'PO-050 balance paid $1,250.50 https://wise.com/share/abc123';
  assert.deepEqual(parseWiseMessage(body), { link: 'https://wise.com/share/abc123', usd: '1250.50', gbp: null });

  const db = setup();
  const t = await noteWiseMessage(db, { id: 'MSG1', timestamp: Date.UTC(2026, 9, 28, 9) / 1000, body, readLink: async () => ({ gbp: '940.12' }) });
  assert.deepEqual({ usd: t.usd, gbp: t.gbp, from: t.gbpFrom }, { usd: '1250.50', gbp: '940.12', from: 'link' });
  assert.equal(await noteWiseMessage(db, { id: 'MSG1', timestamp: 0, body, readLink: async () => ({}) }), null, 'seen once');
  const p = paymentFromTransfer(db.prepare('SELECT * FROM wise_transfers WHERE id = ?').get('wa:MSG1'));
  assert.deepEqual({ date: p.date, usd: p.usd, gbp: p.gbp, po: p.allocation.target, part: p.allocation.part }, { date: '2026-10-28', usd: '1250.50', gbp: '940.12', po: 'PO-050', part: 'balance' });
});

test('only wise.com pages are opened, and the GBP is found in the page or its data', async () => {
  assert.deepEqual(await readWiseLink('https://evil.example/wise.com/x'), { error: 'not a wise.com link' });
  const page = (html) => async () => ({ ok: true, url: 'https://wise.com/share/x', text: async () => html });
  assert.equal((await readWiseLink('https://wise.com/share/x', { fetchImpl: page('<p>You sent <b>&pound;940.12</b></p>') })).gbp, '940.12');
  assert.equal((await readWiseLink('https://wise.com/share/x', { fetchImpl: page('<script>{"sourceCurrency":"GBP","x":1,"sourceAmount":940.12}</script>') })).gbp, '940.12');
  const away = async () => ({ ok: true, url: 'https://elsewhere.example/', text: async () => '' });
  assert.match((await readWiseLink('https://wise.com/share/x', { fetchImpl: away })).error, /away from wise\.com/);
});

test('photos are named as WhatsApp names them, in the business’s timezone', () => {
  assert.equal(whatsappName(Date.UTC(2026, 9, 2, 14, 17, 29) / 1000, 'image/jpeg', 'Europe/London'), 'WhatsApp Image 2026-10-02 at 15.17.29.jpeg');
});
