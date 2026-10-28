// Files from the supplier group: one document per picture, orders found by their
// date and market, corrections by reply, amounts asked and Wise payments. Made-up figures only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-intake-'));
process.env.INVOICE_DIR = dir; // read when intake.js loads
const { openLandingDb, saveLedger } = await import('../../src/landing/store.js');
const { intakeGroupFiles, groupPages, createBursts } = await import('../../src/intake/group.js');
const { parseRequest, noteRequest, applyPayment, noteReply, replyChain } = await import('../../src/intake/requests.js');
const { getDraft } = await import('../../src/invoices/intake.js');
const { getBillDraft } = await import('../../src/bills/intake.js');
const { unsent } = await import('../../src/notify/outbox.js');
const { parseWiseMessage, noteWiseMessage, readWiseLink } = await import('../../src/wise/whatsapp.js');
const { paymentFromTransfer } = await import('../../src/wise/import.js');
const { whatsappName } = await import('../../src/intake/listener.js');
const { createDashboard } = await import('../../src/dashboard/server.js');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Each fake picture says what it is; the labeller and readers see only its bytes.
const pic = (tag, extra = {}) => ({ buffer: Buffer.from(`fake jpeg ${tag}`), filename: `WhatsApp Image 2026-10-16 at 21.23.0${tag.length % 10}.jpeg`, mime: 'image/jpeg', messageId: `MSG-${tag}`, ...extra });
const tagOf = (data) => Buffer.from(data, 'base64').toString().replace('fake jpeg ', '');
const KIND = { dep: 'supplier_invoice', depv2: 'supplier_invoice', bal: 'supplier_invoice', new: 'supplier_invoice', pg2: 'supplier_invoice', billA: 'courier_bill', billB: 'courier_bill', billBv2: 'courier_bill', photo: 'other' };
const labeller = { label: async ({ data }) => ({ kind: KIND[tagOf(data)], continuation: tagOf(data) === 'pg2' }) };

const SUPPLIER = 'TEST LEAF METAL CO.,LTD';
const goods = (qty) => [{ description: '92% gold leaf 10pcs/pack', quantity: qty, unitPrice: 10, amount: qty * 10 }];
const INVOICES = {
  dep: { supplier: SUPPLIER, orderDate: '2026-10-05', marketplaceAsPrinted: 'UK 英国', lines: goods(300), total: 3000, depositPercent: 30, deposit: 900, payUsd: 136, rmbPerUsd: 6.6 },
  depv2: { supplier: SUPPLIER, orderDate: '2026-10-05', marketplaceAsPrinted: 'UK 英国', lines: goods(330), total: 3300, depositPercent: 30, deposit: 990, payUsd: 150, rmbPerUsd: 6.6 },
  bal: { supplier: SUPPLIER, orderDate: '2026-10-05', marketplaceAsPrinted: 'UK 英国', lines: goods(330), total: 3300, depositReceived: 990, balance: 2310, payUsd: 350, rmbPerUsd: 6.6 },
  new: { supplier: SUPPLIER, orderDate: '2026-10-16', marketplaceAsPrinted: 'UK 英国', lines: goods(100), total: 1000, deposit: 300, payUsd: 45, rmbPerUsd: 6.6 },
};
const invoiceReads = [];
const invoiceReader = {
  read: async ({ data, more = [] }) => {
    invoiceReads.push([tagOf(data), ...more.map((m) => tagOf(m.data))]);
    return { currency: 'RMB', ...INVOICES[tagOf(data)] };
  },
};
const BILLS = {
  billA: { rows: [{ fbaId: 'FBA15TEST001', tracking: '1ZTEST0000000001', service: 'europe sea', amount: 200 }], totalRmb: 200, totalUsd: 31, rmbPerUsd: 6.6 },
  billB: { rows: [{ fbaId: null, otherId: '2880000001', tracking: '1ZTEST0000000002', service: 'USA airline', country: 'USA', amount: 400 }], totalRmb: 400, totalUsd: 62, rmbPerUsd: 6.6 },
  billBv2: { rows: [{ fbaId: 'FBA19TEST002', tracking: '1ZTEST0000000002', service: 'USA airline', country: 'USA', amount: 400 }], totalRmb: 400, totalUsd: 62, rmbPerUsd: 6.6 },
};
const billReader = { read: async ({ data }) => BILLS[tagOf(data)] };
const intake = (db, files, extra = {}) => intakeGroupFiles({ db, files, author: 'Atif', chatLabel: 'Supplier group', labeller, invoiceReader, billReader, dir, link: 'https://dash.example', ...extra });

const setup = () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, { products: [{ id: 'G-UK', code: 'G', marketplace: 'UK' }] }, { actor: 'test' });
  return db;
};
const lastCard = (db) => unsent(db).at(-1).text;

test('each picture is its own document, unless it plainly continues the one before', () => {
  const f = (kind, continuation = false, mime = 'image/jpeg') => ({ mime, label: { kind, continuation } });
  const groups = groupPages([f('supplier_invoice'), f('supplier_invoice', true), f('courier_bill'), f('courier_bill'), f('courier_bill', true, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), f('other')]);
  assert.deepEqual(groups.map((g) => [g.kind, g.files.length]), [['supplier_invoice', 2], ['courier_bill', 1], ['courier_bill', 1], ['courier_bill', 1], ['other', 1]]);
});

test('an album of an invoice and two bills: three drafts, one card, checked against the amount Atif asked for', async () => {
  const db = setup();
  invoiceReads.length = 0;
  const out = await intake(db, [pic('new'), pic('billA'), pic('billB'), pic('photo')], { asked: { currency: 'USD', amount: '138' } });
  assert.deepEqual(out.map((o) => o.kind), ['invoice', 'bill', 'bill', 'other']);
  assert.deepEqual(invoiceReads, [['new']]);
  const inv = getDraft(db, out[0].draft.id);
  assert.equal(inv.reading.orderRef, '2026-10-16 UK');
  assert.equal(inv.message_id, 'MSG-new');
  assert.deepEqual(getBillDraft(db, out[2].draft.id).reading.tracking, ['1ZTEST0000000002']);
  const cards = unsent(db);
  assert.equal(cards.length, 1);
  const text = cards[0].text;
  assert.match(text, /^🧾 From Atif in Supplier group: 3 documents, asking to send \$138\n\n1\. Invoice: TEST LEAF METAL CO\.,LTD · order 2026-10-16 UK · deposit \$45\nA new order \(2026-10-16 UK\): save it to a new PO, PO-\d+ being next\./);
  assert.match(text, /2\. Courier bill: 1 line\(s\) · 200 RMB · FBA15TEST001 · \$31\n/);
  assert.match(text, /\n\n\(1 other picture\(s\) left alone: not an invoice or bill\.\)\n✓ \$45 \+ \$31 \+ \$62 = \$138, as Atif asked\.$/);

  const db2 = setup();
  await intake(db2, [pic('new'), pic('billA')], { asked: { currency: 'USD', amount: '100' } });
  assert.match(lastCard(db2), /⚠️ The documents ask for \$45 \+ \$31 = \$76, but Atif asked for \$100\.$/);
});

test('a picture continuing the one before is read with it as one invoice', async () => {
  const db = setup();
  invoiceReads.length = 0;
  const out = await intake(db, [pic('new'), pic('pg2')]);
  assert.equal(out.length, 1);
  assert.deepEqual(invoiceReads, [['new', 'pg2']]);
  assert.match(lastCard(db), /^🧾 From Atif in Supplier group: an invoice\n/);
});

test('an invoice sent as a reply to the feedback on an earlier one sets that one aside', async () => {
  const db = setup();
  const [first] = await intake(db, [pic('dep')]);
  // Ashar replies to it ("Is mai sticker fee kis ki hai?"); the corrected picture replies to that.
  noteReply(db, { id: 'FEEDBACK', quoted: 'MSG-dep', timestamp: 1_800_000_000 });
  assert.deepEqual(replyChain(db, 'FEEDBACK'), ['FEEDBACK', 'MSG-dep']);
  const [second] = await intake(db, [pic('new', { repliesTo: replyChain(db, 'FEEDBACK') })]); // even with another order's date on it
  assert.equal(getDraft(db, first.draft.id).replaced_by, second.draft.id);
  assert.deepEqual(getDraft(db, second.draft.id).reading.replaces, { draft: first.draft.id });
  assert.match(lastCard(db), new RegExp(`↻ Corrects invoice ${first.draft.id} \\(sent as a reply to it\\), which is set aside\\.`));
});

test('the same order from the same supplier: a corrected deposit invoice replaces it; the balance invoice goes to its PO', async () => {
  const db = setup();
  const [first] = await intake(db, [pic('dep')]);
  const [second] = await intake(db, [pic('depv2')]);
  assert.equal(getDraft(db, first.draft.id).status, 'discarded');
  assert.match(lastCard(db), /↻ Corrects invoice \d+, which is set aside\./);

  // Saved to PO-050 on the dashboard, with the order as its supplier ref…
  saveLedger(db, { orders: [{ po: 'PO-050', supplier: 'Test Leaf', marketplace: 'UK', invoices: [{ id: 'PO-050-proforma-2026-10-05', kind: 'proforma', date: '2026-10-05', supplierRef: '2026-10-05 UK', series: 'PO-050-proforma-2026-10-05', lines: [{ kind: 'goods', product: 'G-UK', qty: 330, rmb: 3300 }] }] }] }, { actor: 'test' });
  db.prepare("UPDATE invoice_drafts SET status = 'saved', saved_as = 'PO-050-proforma-2026-10-05' WHERE id = ?").run(second.draft.id);
  // …then the balance invoice comes.
  const [bal] = await intake(db, [pic('bal')]);
  const d = getDraft(db, bal.draft.id);
  assert.equal(d.po, 'PO-050');
  assert.deepEqual(d.reading.replaces, { po: 'PO-050', invoiceId: 'PO-050-proforma-2026-10-05' });
  assert.match(lastCard(db), /For PO-050: the balance invoice, replacing the deposit invoice when saved\./);

  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/invoices/drafts/${d.id}`, { headers: { Cookie: 'actor=Ashar' } })).text();
    assert.match(html, /The balance invoice for PO-050 \(order 2026-10-05 UK\)/);
    assert.match(html, /<option value="PO-050-proforma-2026-10-05" selected>replaces invoice 1/);
    assert.match(html, /<option value="final" selected>/);
    assert.match(html, /asks for <b>\$350\.00<\/b> now at 6\.6 RMB per USD/);
  } finally {
    server.close();
  }
});

test('a balance invoice while the deposit invoice still waits keeps both, and says to save the deposit first', async () => {
  const db = setup();
  const [dep] = await intake(db, [pic('dep')]);
  const [bal] = await intake(db, [pic('bal')]);
  assert.equal(getDraft(db, dep.draft.id).status, 'pending');
  assert.deepEqual(getDraft(db, bal.draft.id).reading.sameOrder, { draft: dep.draft.id });
  assert.match(lastCard(db), new RegExp(`The deposit invoice for this order \\(invoice ${dep.draft.id}\\) is still waiting to be checked: save that one first\\.`));
});

test('an order typed in by hand is found by supplier, market and order date', async () => {
  const db = setup();
  saveLedger(db, { orders: [{ po: 'PO-040', supplier: 'Test Leaf Metal', marketplace: 'UK', invoices: [{ id: 'PO-040-proforma-2026-10-05', kind: 'proforma', date: '2026-10-05', lines: [{ kind: 'goods', product: 'G-UK', qty: 300, rmb: 3000 }] }] }] }, { actor: 'test' });
  const [bal] = await intake(db, [pic('bal')]);
  assert.equal(getDraft(db, bal.draft.id).po, 'PO-040');
});

test('an invoice that found no PO can be opened on one, to say which invoice it replaces', async () => {
  const db = setup();
  saveLedger(db, { orders: [{ po: 'PO-060', supplier: 'Test Leaf Metal', marketplace: 'UK', invoices: [{ id: 'PO-060-final-2026-09-01', kind: 'final', date: '2026-09-01', statedTotalRmb: '3300', lines: [{ kind: 'goods', product: 'G-UK', qty: 330, rmb: 3300 }] }] }] }, { actor: 'test' });
  const [bal] = await intake(db, [pic('bal')]);
  assert.equal(getDraft(db, bal.draft.id).po, null, 'typed in with another date, so not found');
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const page = (q = '') => fetch(`http://127.0.0.1:${server.address().port}/invoices/drafts/${bal.draft.id}${q}`, { headers: { Cookie: 'actor=Ashar' } }).then((r) => r.text());
    const before = await page();
    assert.match(before, /Saving to a new PO\./);
    assert.doesNotMatch(before, /name="series"/);
    const after = await page('?po=PO-060');
    assert.match(after, /Saving to PO-060\./);
    assert.match(after, /<option value="main">replaces invoice 1 .*Both stay on the PO; the newer one counts/);
    assert.match(after, /<input name="po" value="PO-060"/);
  } finally {
    server.close();
  }
});

test('a corrected bill is found by reply, or by its tracking numbers when the FBA IDs were what was wrong', async () => {
  const db = setup();
  const [a] = await intake(db, [pic('billB')]);
  const [b] = await intake(db, [pic('billBv2')]);
  assert.equal(getBillDraft(db, a.draft.id).replaced_by, b.draft.id);
  assert.match(lastCard(db), /↻ Corrects bill \d+, which is set aside\./);

  const db2 = setup();
  const [x] = await intake(db2, [pic('billA')]);
  db2.prepare("UPDATE bill_drafts SET status = 'saved', saved_as = 'CB-007' WHERE id = ?").run(x.draft.id);
  await intake(db2, [pic('billBv2', { repliesTo: ['MSG-billA'] })]);
  assert.match(lastCard(db2), /↻ Corrects CB-007, already saved: fix CB-007 from this one, then discard it\./);
});

test('a reading that fails still leaves a card saying so', async () => {
  const db = setup();
  const out = await intake(db, [{ buffer: Buffer.from('x'), filename: 'notes.docx', mime: 'application/msword' }], { labeller: { label: async () => ({ kind: 'supplier_invoice' }) } });
  assert.ok(out[0].error);
  assert.match(unsent(db)[0].text, /^🧾 From Atif in Supplier group: an invoice\n\n1\. ⚠️ Couldn’t take in this invoice: /);
});

test('files are handed over once the sender has been quiet, with the amount they asked for', async () => {
  const got = [];
  const b = createBursts({ idleMs: 20, onFlush: async (meta, files) => got.push([meta.author, files.length, meta.asked?.amount]) });
  b.add('g|Atif', { author: 'Atif' }, 1);
  b.add('g|Atif', { author: 'Atif' }, 2);
  assert.equal(b.note('g|Atif', { asked: { currency: 'USD', amount: '1250' } }), true);
  assert.equal(b.note('g|Nobody', { asked: {} }), false);
  b.add('g|Ashar', { author: 'Ashar' }, 3);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(got.sort(), [['Ashar', 1, undefined], ['Atif', 2, '1250']]);
});

test('Atif’s “send” messages are payment requests; Wise payments are set against them', () => {
  assert.deepEqual(parseRequest('1250$ send krny supplier ko'), { currency: 'USD', amount: '1250' });
  assert.deepEqual(parseRequest('11538$  send krny supplier ko'), { currency: 'USD', amount: '11538' });
  assert.deepEqual(parseRequest('991$'), { currency: 'USD', amount: '991' });
  assert.deepEqual(parseRequest('12000 RMB send krny supplier ko edible gold ka order confirm krna'), { currency: 'CNY', amount: '12000' });
  for (const no of ['$$ main correct hai amount 4520', '5000 print kerae the?', 'OK. Deposit 1383 pay hua tha']) assert.equal(parseRequest(no), null, no);

  const db = setup();
  const t = (d) => Date.UTC(2026, 9, d, 12) / 1000;
  const ask = (id, day, amount, currency = 'USD') => noteRequest(db, { id, chat: 'G', author: 'Atif', timestamp: t(day), currency, amount });
  ask('R1', 2, '1500');
  assert.equal(applyPayment(db, { chat: 'G', currency: 'USD', amount: '1509', timestamp: t(2) }), '⚠️ $9 more than the $1,500 Atif asked for on 2 Oct.');
  ask('R2', 19, '1250');
  assert.equal(applyPayment(db, { chat: 'G', currency: 'USD', amount: '500', timestamp: t(19) }), 'Part of the $1,250 Atif asked for on 19 Oct: $750 still to send.');
  assert.equal(applyPayment(db, { chat: 'G', currency: 'USD', amount: '750', timestamp: t(19) }), '✓ That completes the $1,250 Atif asked for on 19 Oct.');
  ask('R3', 21, '700');
  assert.equal(applyPayment(db, { chat: 'G', currency: 'USD', amount: '699', timestamp: t(21) }), '⚠️ $1 less than the $700 Atif asked for on 21 Oct.');
  ask('R4', 22, '300');
  ask('R5', 23, '500');
  assert.equal(applyPayment(db, { chat: 'G', currency: 'USD', amount: '800', timestamp: t(24) }), '✓ Pays $300 of 22 Oct and $500 of 23 Oct, as asked.');
  ask('R6', 24, '12000', 'CNY');
  assert.equal(applyPayment(db, { chat: 'G', currency: 'CNY', amount: '12000', timestamp: t(24) }), '✓ Exactly the 12,000 RMB Atif asked for on 24 Oct.');
  assert.equal(applyPayment(db, { chat: 'G', currency: 'USD', amount: '50', timestamp: t(25) }), null, 'nothing open');
});

test('a Wise payment message becomes a transfer to record, with the recipient, and the GBP from the link when it shows it', async () => {
  assert.equal(parseWiseMessage('paid the balance'), null);
  const body = 'Hey TEST TRADING LTD, I just sent you money with Wise. You should receive 1250.50 USD in your account by Monday.\n\nTrack the transfer using this link:\nhttps://wise.com/share/abc123';
  assert.deepEqual(parseWiseMessage(body), { link: 'https://wise.com/share/abc123', recipient: 'TEST TRADING LTD', usd: '1250.50', cny: null, gbp: null });
  assert.equal(parseWiseMessage('Hey Test Person, I just sent you money with Wise. You should receive 12000 CNY by Monday. https://wise.com/x').cny, '12000');

  const db = setup();
  const t = await noteWiseMessage(db, { id: 'MSG1', timestamp: Date.UTC(2026, 9, 28, 9) / 1000, body: `PO-050 balance ${body}`, readLink: async () => ({ gbp: '940.12' }) });
  assert.deepEqual({ usd: t.usd, gbp: t.gbp, from: t.gbpFrom, to: t.recipient }, { usd: '1250.50', gbp: '940.12', from: 'link', to: null });
  assert.equal(await noteWiseMessage(db, { id: 'MSG1', timestamp: 0, body, readLink: async () => ({}) }), null, 'seen once');
  const p = paymentFromTransfer(db.prepare('SELECT * FROM wise_transfers WHERE id = ?').get('wa:MSG1'));
  assert.deepEqual({ date: p.date, usd: p.usd, gbp: p.gbp, po: p.allocation.target, part: p.allocation.part }, { date: '2026-10-28', usd: '1250.50', gbp: '940.12', po: 'PO-050', part: 'balance' });

  const c = await noteWiseMessage(db, { id: 'MSG2', timestamp: Date.UTC(2026, 9, 28, 9) / 1000, body: 'Hey Test Person, I just sent you money with Wise. You should receive 12000 CNY by Monday. https://wise.com/x', readLink: async () => ({ usd: '2000' }) });
  assert.deepEqual({ usd: c.usd, cny: c.cny }, { usd: null, cny: '12000' });
  assert.deepEqual(db.prepare('SELECT target_currency, target_value FROM wise_transfers WHERE id = ?').get('wa:MSG2'), { target_currency: 'CNY', target_value: '12000' });
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
