// Reading courier bills: the layout of the agent's "Shipping fee bills" sheet,
// with made-up shipment IDs and amounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import Database from 'better-sqlite3';
import { billFromRows, matchShipment, readExcelBill, rawFromCells } from '../../src/bills/read.js';
import { checkBill } from '../../src/bills/checks.js';
import { computeLandingCosts } from '../../src/landing/engine.js';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { RAW } from './fixture.js';

const ON_FILE = ['FBA99TEST0B1', 'FBA99TEST2C3'];


test('bill rows become lines: domestic fees join the shipment above, fees and rate differences stand alone', () => {
  const r = billFromRows(RAW, ON_FILE);
  assert.deepEqual(r.lines.map((l) => [l.kind, l.shipment || null, l.rmb]), [
    ['shipping', 'FBA99TEST0B1', '1000'],
    ['domestic', 'FBA99TEST0B1', '50'],
    ['shipping', 'FBA99TEST2C3', '900'], // read as …ZC3, matched to the one on file
    ['domestic', 'FBA99TEST2C3', '50'],
    ['fee', null, '20'],
    ['adjustment', null, '-100'],
  ]);
  assert.equal(r.statedTotalRmb, '1920');
  assert.equal(r.rmbPerUsd, '6.4');
  assert.ok(r.notes.some((n) => /read as FBA99TESTZC3; taken as FBA99TEST2C3/.test(n.message)));
  assert.deepEqual(r.unread, []);
});

test('a row with no FBA ID is still a shipment to Amazon: left for the checker to pick, with likely shipments suggested', () => {
  // Laid out like the 19 Oct bill: the agent's own reference sits where the FBA ID goes.
  const raw = {
    rows: [
      { date: '2026-10-13', fbaId: null, otherId: '1234567890', service: 'Germany airline included tax', country: '德国 germany', amount: 1300 },
      { fbaId: null, country: 'Domestic shipping fee', amount: 40 },
      { date: '2026-10-19', fbaId: null, otherId: '1234567891', service: 'USA airline included tax', country: '美国 USA', amount: 700 },
    ],
    totalRmb: 2040,
    rmbPerUsd: 6.6,
  };
  const shipments = [
    { id: 'FBA99DE00001', marketplace: 'DE', createdAt: '2026-10-11', billed: false },
    { id: 'FBA99DE00002', marketplace: 'DE', createdAt: '2026-10-09', billed: true }, // already on a bill
    { id: 'FBA99DE00003', marketplace: 'DE', createdAt: '2026-08-01', billed: false }, // too early
    { id: 'FBA99US00001', marketplace: 'US', createdAt: '2026-09-01', billed: false }, // too early
  ];
  const r = billFromRows(raw, shipments);
  assert.deepEqual(r.lines.map((l) => [l.kind, l.shipment || null, l.rmb]), [['shipping', null, '1300'], ['domestic', null, '40'], ['shipping', null, '700']]);
  const say = r.notes.map((n) => n.message).join('\n');
  assert.match(say, /Line 1: no FBA ID on the bill \(1234567890 is printed where the FBA ID goes\)\. Enter its FBA shipment\. Likely: FBA99DE00001 \(DE, created 11 Oct\)\. If the goods went to a 3PL/);
  assert.match(say, /Line 2: domestic shipping fee for line 1: give it the same FBA shipment/);
  assert.match(say, /Line 3: no FBA ID .* No US shipment without a bill, from around 19 Oct, is on the dashboard yet/);
});

test('a shipping row with no FBA ID and no known country is still a shipping line; unread totals are listed', () => {
  const r = billFromRows({ rows: [{ fbaId: null, service: 'UK sea', country: 'UK', amount: 700 }, { fbaId: null, country: 'domestic shipping fee', amount: 30 }], totalRmb: null, rmbPerUsd: null }, []);
  assert.equal(r.lines[0].kind, 'shipping');
  assert.deepEqual(r.unread, ['Bill total (RMB)', 'Exchange rate']);
});

test('an ID that is not on file, and matches none by look-alike characters, is kept as read and flagged', () => {
  assert.deepEqual(matchShipment('fba99new0001', ON_FILE), { id: 'FBA99NEW0001', onFile: false });
  const r = billFromRows({ rows: [{ fbaId: 'FBA99NEW0001', service: 'x', amount: 5 }], totalRmb: 5, rmbPerUsd: 7 }, ON_FILE);
  assert.ok(r.notes.some((n) => n.severity === 'warning' && /isn't on the dashboard yet/.test(n.message)));
});

test('checks: lines against the total, USD at the bill rate, the 1% fee', () => {
  const good = checkBill(billFromRows(RAW, ON_FILE));
  assert.ok(good.some((c) => c.severity === 'ok' && /Lines add up to the bill total, 1,920/.test(c.message)));
  assert.ok(good.some((c) => c.severity === 'ok' && /at 6.4 is \$300.00; the bill asks \$300.00/.test(c.message)));
  assert.ok(good.some((c) => c.severity === 'ok' && /Service fee 20 is 1% of the shipping \(2,000\)/.test(c.message)));

  const bad = checkBill(billFromRows({ ...RAW, totalRmb: 2000, totalUsd: 320 }, ON_FILE));
  assert.ok(bad.some((c) => c.severity === 'warning' && /lines under by 80/.test(c.message)));
  assert.ok(bad.some((c) => c.severity === 'warning' && /bill asks \$320.00/.test(c.message)));
});

test('an Excel copy of the bill reads the same as the photo', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Shipping fee bills']);
  ws.addRow(['日期(date)', '序号 FBA ID', '客户运单号 (client domestic tracking)', '转单号 (tracking no.)', '件数 (cartons)', '收费重 (charged weight)', '服务类型 (shipping line)', '发往国家 (country)', '金额 amount (RMB)', '主品名 (products name)']);
  ws.addRow(['2026-09-17', 'FBA99TEST0B1', '9', '111', 2, 24, 'USA airline included tax', 'USA', 1000, 'gold flakes']);
  ws.addRow(['2026-09-17', '', '', '', '', '', '', 'domestic shipping fee', 50]);
  ws.addRow(['2026-09-24', 'FBA99TEST2C3', '8', '222', 1, 15.5, 'USA airline included tax', 'USA', 900, 'silver paper']);
  ws.addRow(['2026-09-24', '', '', '', '', '', '', 'domestic shipping fee', 50]);
  ws.addRow(['', '', '', '', '', '', '1% of Annie service fee', '', 20]);
  ws.addRow(['', '', '', '', '', '', 'Last time payment rate difference', '', -100]);
  ws.addRow(['', '', '', '', '', '', '人民币总计(totaly RMB )', '', 1920]);
  ws.addRow(['', '', '', '', '', '', 'Totaly Amount(USD) Today rate 6.4', '', 300]);
  const raw = await readExcelBill(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(raw.totalRmb, 1920);
  assert.equal(raw.totalUsd, 300);
  assert.equal(raw.rmbPerUsd, 6.4);
  const fromExcel = billFromRows(raw, ON_FILE);
  assert.deepEqual(fromExcel.lines.map((l) => [l.kind, l.shipment || null, l.rmb]), billFromRows(RAW, ON_FILE).lines.map((l) => [l.kind, l.shipment || null, l.rmb]));
});

test('an onward line stays out of landing cost until it names its FBA shipment', () => {
  const ledger = {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }],
    orders: [{ po: 'PO-1', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 200, rmb: 2000 }] }] }],
    payments: [{ id: 'P1', date: '2026-01-01', gbp: 100, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }, { id: 'P2', date: '2026-01-02', gbp: 30, usd: 40, allocations: [{ type: 'bill', target: 'B1' }] }],
    shipments: [{ id: 'FBA99SHIP001', marketplace: 'UK', items: [{ product: 'A-UK', po: 'PO-1', shipped: 100 }] }, { id: 'FBA99SHIP002', marketplace: 'UK', items: [{ product: 'A-UK', po: 'PO-1', shipped: 100 }] }],
    courierBills: [{ id: 'B1', agent: 'Agent', date: '2026-01-02', statedTotalRmb: 300, rmbPerUsd: 7.5, lines: [{ kind: 'shipping', shipment: 'FBA99SHIP001', rmb: 200 }, { kind: 'onward', rmb: 100, description: 'UK 3PL' }] }],
  };
  const held = computeLandingCosts(ledger);
  const one = held.shipments.find((s) => s.id === 'FBA99SHIP001');
  assert.equal(one.delivery.total.toFixed(2), '20.00'); // its 200 of the 300 RMB paid: two thirds of £30
  assert.ok(held.issues.some((i) => i.code === 'bill_awaiting_shipment' && /100 RMB of shipping to UK 3PL/.test(i.message)));
  assert.equal(held.shipments.find((s) => s.id === 'FBA99SHIP002').delivery.bills.length, 0);

  ledger.courierBills[0].lines[1].shipment = 'FBA99SHIP002';
  const placed = computeLandingCosts(ledger);
  assert.equal(placed.shipments.find((s) => s.id === 'FBA99SHIP002').delivery.total.toFixed(2), '10.00');
  assert.ok(!placed.issues.some((i) => i.code === 'bill_awaiting_shipment'));
});

test('an older database gains the onward kind without losing bill lines', () => {
  const file = `${process.env.TMPDIR || '/tmp'}/bills-migrate-${process.pid}.db`;
  const old = new Database(file);
  old.exec(`CREATE TABLE courier_bills (id TEXT PRIMARY KEY, agent TEXT, date TEXT, stated_total_rmb TEXT, rmb_per_usd TEXT, file_path TEXT);
CREATE TABLE courier_bill_lines (id INTEGER PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES courier_bills(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shipping','domestic','fee','adjustment','expense')), shipment TEXT, rmb TEXT, description TEXT, category TEXT);
INSERT INTO courier_bills (id) VALUES ('OLD');
INSERT INTO courier_bill_lines (bill_id, seq, kind, shipment, rmb) VALUES ('OLD', 0, 'shipping', 'FBA99OLD0001', '12');`);
  old.close();
  try {
    const db = openLandingDb(file);
    assert.equal(db.prepare("SELECT shipment FROM courier_bill_lines WHERE bill_id = 'OLD'").get().shipment, 'FBA99OLD0001');
    saveLedger(db, { courierBills: [{ id: 'NEW', agent: 'A', date: '2026-01-01', lines: [{ kind: 'onward', rmb: 5, description: 'home' }] }] }, { actor: 'test' });
    assert.equal(loadLedger(db).courierBills.find((b) => b.id === 'NEW').lines[0].kind, 'onward');
    db.close();
  } finally {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }
});

test('in Excel, a number in the FBA ID column is kept as the agent\'s reference, not taken as an ID', () => {
  const raw = rawFromCells([
    ['日期(date)', '序号 FBA ID', '转单号 (tracking no.)', '服务类型 (shipping line)', '发往国家 (country)', '金额 amount (RMB)'],
    ['2026-10-19', 1234567891, '1Z0000', 'USA airline included tax', 'USA', 700],
    ['2026-10-20', 'FBA99US00002', '1Z0001', 'USA airline included tax', 'USA', 500],
  ]);
  assert.deepEqual(raw.rows.map((r) => [r.fbaId, r.otherId]), [[null, '1234567891'], ['FBA99US00002', null]]);
});

test('a bill whose RMB total leaves out the 1% fee is corrected to the full total its USD is worked out on', async () => {
  // Like the 12 Sep UK bill: 1,944 + 80, "total" 2,024, then a 20 fee, then $310 at 6.60.
  const raw = { rows: [{ fbaId: 'FBA99TEST0B1', service: 'europe sea', country: 'UK', amount: 1944 }, { fbaId: null, description: 'domestic shipping fee', amount: 80 }, { fbaId: null, description: '1% of Annie bank service fee', amount: 20 }], totalRmb: 2024, totalUsd: 310, rmbPerUsd: 6.6 };
  const reading = billFromRows(raw, ON_FILE);
  const { totalWithoutFee } = await import('../../src/bills/checks.js');
  assert.equal(totalWithoutFee(reading), '2044');
  reading.printedTotalRmb = reading.statedTotalRmb;
  reading.statedTotalRmb = '2044';
  const checks = checkBill(reading);
  assert.ok(checks.some((c) => c.severity === 'warning' && /RMB total \(2,024\) leaves out the 20 RMB fee .* set to 2,044/.test(c.message)));
  assert.ok(checks.some((c) => c.severity === 'ok' && /Lines add up to the bill total, 2,044/.test(c.message)));
  assert.ok(checks.some((c) => c.severity === 'ok' && /the bill asks \$310.00 ✓/.test(c.message)));
  // A total that is simply wrong isn't "corrected".
  assert.equal(totalWithoutFee({ ...reading, statedTotalRmb: '2000' }), null);
  // Nor when the USD doesn't fit the full total.
  assert.equal(totalWithoutFee({ ...reading, statedTotalRmb: '2024', totalUsd: '400' }), null);
});
