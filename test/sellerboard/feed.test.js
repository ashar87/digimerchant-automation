// Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeLandingCosts } from '../../src/landing/engine.js';
import ExcelJS from 'exceljs';
import { buildFeed, toXlsx, feedValues, HEADERS } from '../../src/sellerboard/feed.js';
import { readSellerboardExport, saveCatalog, loadCatalog } from '../../src/sellerboard/catalog.js';
import { createSheetsWriter } from '../../src/google/sheets.js';
import { publishFeed } from '../../src/sellerboard/publish.js';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';
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

// Sellerboard's own product rows, as its export has them.
const sbRows = {
  'uk-de': [{ ASIN: 'B000UK', SKU: 'SKU-A', Title: 'Product A', Labels: '#FBA', CostPeriodStartDate: '01/12/2025', Cost: 0.9, VAT: 20, VAT_CATEGORY: 'A_GEN_STANDARD', Hide: 'NO', Marketplace: 'Amazon.co.uk', BatchQuantity: 1, EAN: '5000000000001' }],
  us: [{ ASIN: 'B000TEST', SKU: 'SKU-US', Title: 'Product A (US)', Hide: 'NO', Marketplace: 'Amazon.com' }],
};
const catalogOf = (rows) => Object.fromEntries(Object.entries(rows).map(([a, list]) => [a, { rows: new Map(list.map((v) => [`${v.Marketplace || ''}|${v.SKU}`, v])) }]));
const catalog = catalogOf(sbRows);

test('one row per product per shipment, GBP for the UK, USD for the US, added and dated when receiving starts', () => {
  const l = ledger();
  const feed = buildFeed(l, computeLandingCosts(l), { catalog });
  const uk = feed.rows.find((r) => r.shipment === 'FBA-UK');
  assert.deepEqual(
    { sku: uk.sku, marketplace: uk.marketplace, date: uk.date, quantity: uk.quantity, cost: uk.cost, exactCost: uk.exactCost, currency: uk.currency, status: uk.status },
    { sku: 'SKU-A', marketplace: 'Amazon.co.uk', date: '2026-01-20', quantity: '100', cost: '1.11', exactCost: '1.1125', currency: 'GBP', status: 'final' }, // 1.00 + 40×0.75×300/400÷200
  );
  // Sellerboard's template, all 17 columns: the batch fields are ours, the rest copied from its own row.
  const row = Object.fromEntries(HEADERS.map((h, i) => [h, uk.values[i]]));
  assert.deepEqual(row, { ASIN: 'B000UK', SKU: 'SKU-A', Title: 'Product A', Labels: '#FBA', CostPeriodStartDate: '20/01/2026', Cost: 1.11, DomesticShippingCost: null, RestofworldShippingCost: null, ShippingProfile: null, Value_of_unsellable_returns: null, VAT: 20, VAT_CATEGORY: 'A_GEN_STANDARD', Hide: 'NO', Marketplace: 'Amazon.co.uk', BatchQuantity: 100, EAN: '5000000000001', UPC: null });
  // Shipped but not received: nothing goes to Sellerboard until Amazon starts receiving.
  assert.equal(feed.rows.find((r) => r.shipment === 'FBA-US'), undefined);
  assert.match(feed.held.find((h) => h.shipment === 'FBA-US').reason, /Not received yet/);

  l.shipments[1].firstReceivedAt = '2026-02-20';
  const us = buildFeed(l, computeLandingCosts(l), { catalog }).rows.find((r) => r.shipment === 'FBA-US');
  assert.deepEqual({ currency: us.currency, asin: us.asin, sku: us.sku, date: us.date }, { currency: 'USD', asin: 'B000TEST', sku: 'SKU-US', date: '2026-02-20' }); // matched by ASIN
});

test('nothing goes out without Sellerboard’s own row for the product, so no setting is ever blanked', () => {
  const l = ledger();
  const result = computeLandingCosts(l);
  assert.match(buildFeed(l, result).held.find((h) => h.shipment === 'FBA-UK').reason, /product list for the UK \+ DE account isn’t uploaded/);
  const other = catalogOf({ 'uk-de': [{ ...sbRows['uk-de'][0], SKU: 'SKU-Z' }] });
  assert.match(buildFeed(l, result, { catalog: other }).held.find((h) => h.shipment === 'FBA-UK').reason, /SKU-A on Amazon.co.uk isn’t in Sellerboard’s product list/);
  // A product Sellerboard lists with no cost yet (no marketplace) still has its settings to copy.
  const bare = catalogOf({ 'uk-de': [{ ASIN: 'B000UK', SKU: 'SKU-A', Title: 'Product A', Hide: 'NO', Marketplace: null }] });
  const r = buildFeed(l, result, { catalog: bare }).rows.find((x) => x.shipment === 'FBA-UK');
  assert.equal(r.values[HEADERS.indexOf('Marketplace')], 'Amazon.co.uk');
  assert.equal(r.values[HEADERS.indexOf('Title')], 'Product A');
});

test('each Sellerboard account gets only its own marketplaces: UK and DE in one, the US in the other', () => {
  const l = ledger();
  l.shipments[1].firstReceivedAt = '2026-02-20';
  const result = computeLandingCosts(l);
  assert.deepEqual(buildFeed(l, result, { account: 'uk-de', catalog }).rows.map((r) => r.shipment), ['FBA-UK']);
  assert.deepEqual(buildFeed(l, result, { account: 'us', catalog }).rows.map((r) => [r.shipment, r.currency, r.account]), [['FBA-US', 'USD', 'us']]);
  assert.ok(buildFeed(l, result, { account: 'us', catalog }).held.every((h) => h.marketplace === 'US'));
});

test('each account’s sheet is written on its own, and one failing doesn’t stop the other', async () => {
  const db = openLandingDb(':memory:');
  const l = ledger();
  l.shipments[1].firstReceivedAt = '2026-02-20';
  saveLedger(db, l, { actor: 'test' });
  for (const [account, rows] of Object.entries(sbRows)) saveCatalog(db, { account, rows, actor: 'test' });
  const got = {};
  const writers = {
    'uk-de': { replaceTab: async (values) => ((got['uk-de'] = values), { rows: values.length - 1 }) },
    us: { replaceTab: async () => { throw new Error('no access'); } },
  };
  const r = await publishFeed({ db, writers });
  assert.equal(r.ok, false);
  assert.deepEqual(r.results, [{ account: 'uk-de', ok: true, rows: 1 }, { account: 'us', ok: false, error: 'no access' }]);
  assert.deepEqual(got['uk-de'][0], HEADERS);
  assert.equal(got['uk-de'][1][HEADERS.indexOf('Marketplace')], 'Amazon.co.uk');
  assert.equal(got['uk-de'][1][HEADERS.indexOf('Cost')], 1.11); // a number, so the sheet doesn't hold it as text
  const runs = db.prepare('SELECT kind, ok FROM sync_runs ORDER BY id').all().map((x) => `${x.kind}:${x.ok}`);
  assert.deepEqual(runs, ['sellerboard:uk-de:1', 'sellerboard:us:0']);
});

test('a shipment marked received or closed without a receiving date is held, with what to do', () => {
  const l = ledger();
  l.shipments[0].firstReceivedAt = undefined;
  const held = buildFeed(l, computeLandingCosts(l), { catalog }).held.find((h) => h.shipment === 'FBA-UK' && h.product === 'A-UK');
  assert.match(held.reason, /date it started isn’t recorded/);
});

test('held back, with a reason: typed in by hand, unchecked imports, no SKU', () => {
  const l = ledger();
  const reasons = Object.fromEntries(buildFeed(l, computeLandingCosts(l), { catalog }).held.map((h) => [`${h.shipment}:${h.product}`, h.reason]));
  assert.match(reasons['FBA-OLD:A-UK'], /by hand/);
  assert.match(reasons['FBA-NEW:A-UK'], /PO-3 not checked/);
  assert.match(reasons['FBA-UK:C-UK'], /no SKU or ASIN/);
});

test('the import file is Sellerboard’s template as .xlsx, and its own exports read back in', async () => {
  const l = ledger();
  const rows = buildFeed(l, computeLandingCosts(l), { catalog }).rows;
  const buffer = await toXlsx(rows);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  assert.deepEqual(ws.getRow(1).values.slice(1), HEADERS);
  assert.equal(ws.getRow(2).getCell(6).value, 1.11);
  assert.equal(ws.getRow(2).getCell(6).numFmt, '0.00');

  const read = await readSellerboardExport(buffer);
  assert.equal(read.account, 'uk-de');
  assert.equal(read.rows[0].EAN, '5000000000001');
  await assert.rejects(readSellerboardExport(Buffer.from('not a spreadsheet')), /isn’t an Excel file/);
});

test('an uploaded product list replaces the account’s last one', () => {
  const db = openLandingDb(':memory:');
  saveCatalog(db, { account: 'us', rows: sbRows.us, actor: 'Ashar' });
  saveCatalog(db, { account: 'us', rows: [...sbRows.us, { SKU: 'SKU-2', Marketplace: 'Amazon.com' }], actor: 'Ashar' });
  const c = loadCatalog(db);
  assert.equal(c.us.count, 2);
  assert.ok(c.us.rows.get('Amazon.com|SKU-2'));
  assert.equal(c['uk-de'], undefined);
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
  const out = await writer.replaceTab(feedValues(buildFeed(l, computeLandingCosts(l), { catalog }).rows));
  assert.equal(out.rows, 1);

  const assertion = new URLSearchParams(calls[0].init.body).get('assertion');
  const [h, p, sig] = assertion.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.match(calls[1].url, /SHEET1\/values\/'COGS':clear$/);
  assert.match(calls[2].url, /values\/'COGS'!A1\?valueInputOption=RAW$/);
  assert.equal(calls[2].init.headers.Authorization, 'Bearer g-tok');
  assert.equal(JSON.parse(calls[2].init.body).values[0][0], 'ASIN'); // Sellerboard's own column order
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
