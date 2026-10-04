// Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeLandingCosts } from '../../src/landing/engine.js';
import { buildFeed, toCsv, feedValues } from '../../src/sellerboard/feed.js';
import { createSheetsWriter } from '../../src/google/sheets.js';
import { encryptFile, decryptFile } from '../../src/landing/backup.js';

const ledger = () => ({
  products: [
    { id: 'A-UK', code: 'A', marketplace: 'UK', sku: 'SKU-A' },
    { id: 'A-US', code: 'A', marketplace: 'US', asin: 'B000TEST' },
    { id: 'C-UK', code: 'C', marketplace: 'UK' },
  ],
  orders: [
    { po: 'PO-1', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 1000 }, { kind: 'goods', product: 'C-UK', qty: 100, rmb: 1000 }] }] },
    { po: 'PO-2', supplier: 'S', marketplace: 'US', invoices: [{ id: 'i2', kind: 'final', lines: [{ kind: 'goods', product: 'A-US', qty: 50, rmb: 500 }] }] },
    { po: 'PO-3', supplier: 'S', marketplace: 'UK', review: 'needs_review', invoices: [{ id: 'i3', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 10, rmb: 100 }] }] },
  ],
  payments: [
    { id: 'P1', date: '2026-01-01', gbp: 200, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] },
    { id: 'P2', date: '2026-01-01', usd: 100, allocations: [{ type: 'order', target: 'PO-2', part: 'full' }] },
    { id: 'P3', date: '2026-01-01', gbp: 10, allocations: [{ type: 'order', target: 'PO-3', part: 'full' }] },
    { id: 'P4', date: '2026-02-01', usd: 40, qbRate: '0.75', allocations: [{ type: 'bill', target: 'B1', usd: 40 }] },
  ],
  courierBills: [{ id: 'B1', lines: [{ kind: 'shipping', shipment: 'FBA-UK', rmb: 300 }, { kind: 'shipping', shipment: 'FBA-US', rmb: 100 }] }],
  shipments: [
    { id: 'FBA-UK', marketplace: 'UK', status: 'CLOSED', createdAt: '2026-01-10', firstReceivedAt: '2026-01-20', items: [{ product: 'A-UK', po: 'PO-1', shipped: 100, received: 100 }, { product: 'C-UK', po: 'PO-1', shipped: 100, received: 100 }] },
    { id: 'FBA-US', marketplace: 'US', status: 'SHIPPED', createdAt: '2026-01-12', items: [{ product: 'A-US', po: 'PO-2', shipped: 50 }] },
    { id: 'FBA-OLD', marketplace: 'UK', status: 'CLOSED', createdAt: '2025-12-01', sellerboardManual: true, items: [{ product: 'A-UK', shipped: 1, received: 1 }] },
    { id: 'FBA-NEW', marketplace: 'UK', status: 'RECEIVING', createdAt: '2026-01-15', firstReceivedAt: '2026-01-25', items: [{ product: 'A-UK', po: 'PO-3', shipped: 10 }] },
  ],
});

test('one row per product per shipment, GBP for the UK, USD for the US, added and dated when receiving starts', () => {
  const l = ledger();
  const feed = buildFeed(l, computeLandingCosts(l));
  const uk = feed.rows.find((r) => r.shipment === 'FBA-UK');
  assert.deepEqual(
    { sku: uk.sku, marketplace: uk.marketplace, date: uk.date, quantity: uk.quantity, cost: uk.cost, currency: uk.currency, status: uk.status },
    { sku: 'SKU-A', marketplace: 'Amazon.co.uk', date: '2026-01-20', quantity: '100', cost: '1.1125', currency: 'GBP', status: 'final' }, // 1.00 + 40×0.75×300/400÷200
  );
  // Shipped but not received: nothing goes to Sellerboard until Amazon starts receiving.
  assert.equal(feed.rows.find((r) => r.shipment === 'FBA-US'), undefined);
  assert.match(feed.held.find((h) => h.shipment === 'FBA-US').reason, /Not received yet/);

  l.shipments[1].firstReceivedAt = '2026-02-20';
  const us = buildFeed(l, computeLandingCosts(l)).rows.find((r) => r.shipment === 'FBA-US');
  assert.deepEqual({ currency: us.currency, asin: us.asin, date: us.date }, { currency: 'USD', asin: 'B000TEST', date: '2026-02-20' });
});

test('a shipment marked received or closed without a receiving date is held, with what to do', () => {
  const l = ledger();
  l.shipments[0].firstReceivedAt = undefined;
  const held = buildFeed(l, computeLandingCosts(l)).held.find((h) => h.shipment === 'FBA-UK' && h.product === 'A-UK');
  assert.match(held.reason, /date it started isn’t recorded/);
});

test('held back, with a reason: typed in by hand, unchecked imports, no SKU', () => {
  const l = ledger();
  const reasons = Object.fromEntries(buildFeed(l, computeLandingCosts(l)).held.map((h) => [`${h.shipment}:${h.product}`, h.reason]));
  assert.match(reasons['FBA-OLD:A-UK'], /by hand/);
  assert.match(reasons['FBA-NEW:A-UK'], /PO-3 not checked/);
  assert.match(reasons['FBA-UK:C-UK'], /no SKU or ASIN/);
});

test('CSV quotes separators and defuses spreadsheet formulas', () => {
  const csv = toCsv([{ sku: '=HYPERLINK("x")', asin: 'a,b', marketplace: 'Amazon.co.uk', date: '2026-01-01', quantity: '5', cost: '-1.0000', currency: 'GBP', shipment: 'F', status: 'final' }]);
  const line = csv.split('\r\n')[1];
  assert.ok(line.startsWith(`"'=HYPERLINK(""x"")",` ));
  assert.ok(line.includes('"a,b"'));
  assert.ok(line.includes(',-1.0000,'));
});

test('the Sheets writer logs in with a signed service-account token, clears the tab, then writes it', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'g-tok', expires_in: 3600 }));
    return new Response('{}');
  };
  const writer = createSheetsWriter({ key: { client_email: 'feed@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, sheetId: 'SHEET1', tab: 'COGS', fetch });
  const l = ledger();
  const out = await writer.replaceTab(feedValues(buildFeed(l, computeLandingCosts(l)).rows));
  assert.equal(out.rows, 1);

  const assertion = new URLSearchParams(calls[0].init.body).get('assertion');
  const [h, p, sig] = assertion.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.match(calls[1].url, /SHEET1\/values\/'COGS':clear$/);
  assert.match(calls[2].url, /values\/'COGS'!A1\?valueInputOption=RAW$/);
  assert.equal(calls[2].init.headers.Authorization, 'Bearer g-tok');
  assert.equal(JSON.parse(calls[2].init.body).values[0][0], 'SKU');
});

test('backups decrypt only with the right passphrase', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'in'), 'landing records');
    encryptFile(path.join(dir, 'in'), path.join(dir, 'enc'), 'correct horse');
    assert.ok(!fs.readFileSync(path.join(dir, 'enc')).includes('landing records'));
    decryptFile(path.join(dir, 'enc'), path.join(dir, 'out'), 'correct horse');
    assert.equal(fs.readFileSync(path.join(dir, 'out'), 'utf8'), 'landing records');
    assert.throws(() => decryptFile(path.join(dir, 'enc'), path.join(dir, 'bad'), 'wrong'), /Wrong passphrase/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
