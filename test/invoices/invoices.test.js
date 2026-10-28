// Invoice reading and intake. Made-up figures only; no API is ever called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { readExcelInvoice } from '../../src/invoices/excel.js';
import { checkReading } from '../../src/invoices/checks.js';
import { normaliseModelReading } from '../../src/invoices/model.js';
import { intakeInvoice, pendingDrafts } from '../../src/invoices/intake.js';
import { openLandingDb, saveLedger } from '../../src/landing/store.js';

export async function sampleXlsx({ total = 10630, deposit = 3189 } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PI');
  ws.addRow(['形式发票 PROFORMA INVOICE']);
  ws.addRow(['Invoice No:', 'PI-0001', '', '日期 Date:', '2026-09-21']);
  ws.addRow(['Ship to: USA']);
  ws.addRow([]);
  ws.addRow(['No.', '品名 Description', '数量 Qty', '单价 Unit price', '金额 Amount']);
  ws.addRow([1, 'Test gold leaf 10pcs/pack', 200, 30, { formula: 'C6*D6', result: 6000 }]);
  ws.addRow([2, 'Test gold leaf 30pcs/pack', 50, 90, 4500]);
  ws.addRow([3, 'Packing labour 0.1/pack', 250, 0.1, 25]);
  ws.addRow([4, 'Service fee 1%', '', '', 105]);
  ws.addRow(['', '合计 Total', '', '', total]);
  ws.addRow([]);
  ws.addRow(['', 'Deposit 30%', '', '', deposit]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const products = [
  { id: 'T10-US', code: 'T10', marketplace: 'US', name: 'Test gold leaf 10pcs/pack' },
  { id: 'T30-US', code: 'T30', marketplace: 'US', name: 'Test gold leaf 30pcs/pack' },
];

test('an Excel invoice is read exactly: lines, kinds, total, deposit, header details', async () => {
  const r = await readExcelInvoice(await sampleXlsx());
  assert.equal(r.method, 'excel');
  assert.equal(r.invoiceNumber, 'PI-0001');
  assert.equal(r.date, '2026-09-21');
  assert.deepEqual(r.lines.map((l) => [l.kind, l.qty, l.rmb]), [['goods', '200', '6000'], ['goods', '50', '4500'], ['labour', '250', '25'], ['fee', null, '105']]);
  assert.equal(r.statedTotalRmb, '10630');
  assert.equal(r.depositRmb, '3189');
  assert.equal(r.depositPercent, '30');
  const checks = checkReading(r);
  assert.ok(checks.every((c) => c.severity === 'ok'), JSON.stringify(checks.filter((c) => c.severity !== 'ok')));
});

test('the arithmetic checks catch a wrong total, a wrong line and an odd deposit', async () => {
  const r = await readExcelInvoice(await sampleXlsx({ total: 10721, deposit: 2000 }));
  r.lines[1].rmb = '4400';
  const warnings = checkReading(r).filter((c) => c.severity !== 'ok').map((c) => c.message).join('\n');
  assert.match(warnings, /50 × 90 = 4,500, but the line says 4,400/);
  assert.match(warnings, /invoice total says 10,721/);
  assert.match(warnings, /Deposit 2,000 is 19\.0% of 10,530, not 30%/);
});

test('what a model couldn’t read stays blank and is called out', () => {
  const r = normaliseModelReading({ lines: [{ description: 'Test gold leaf 10pcs/pack', quantity: 200, unitPrice: null, amount: null }], total: null, currency: 'RMB', model: 'fake' });
  assert.equal(r.lines[0].rmb, null);
  assert.equal(r.statedTotalRmb, null);
  const warnings = checkReading(r).map((c) => c.message).join('\n');
  assert.match(warnings, /amount couldn’t be read/);
  assert.match(warnings, /Invoice total couldn’t be read; it’s left blank, not guessed/);
});

function setup() {
  const db = openLandingDb(':memory:');
  saveLedger(db, { products, orders: [{ po: 'PO-007', supplier: 'S', marketplace: 'US', invoices: [] }] }, { actor: 'test' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-test-'));
  return { db, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('intake keeps the file once, suggests products, and saves a draft', async () => {
  const { db, dir, done } = setup();
  try {
    const buffer = await sampleXlsx();
    const d = await intakeInvoice({ db, buffer, filename: 'pi.xlsx', mime: 'application/octet-stream', source: 'upload', actor: 'Ashar', po: 'PO-007', dir });
    assert.equal(d.reading.marketplace, 'US');
    assert.deepEqual(d.reading.lines.map((l) => l.product ?? null), ['T10-US', 'T30-US', null, null]);
    await intakeInvoice({ db, buffer, filename: 'again.xlsx', source: 'upload', actor: 'Ashar', dir });
    assert.equal(fs.readdirSync(dir).length, 1); // same file, stored once
    assert.equal(pendingDrafts(db).length, 2);
  } finally {
    done();
  }
});

test('a PDF is read by the model only when one is set up; otherwise it waits to be typed in', async () => {
  const { db, dir, done } = setup();
  try {
    const pdf = Buffer.from('%PDF-1.4 test');
    const none = await intakeInvoice({ db, buffer: pdf, filename: 'pi.pdf', source: 'upload', actor: 'Ashar', dir });
    assert.equal(none.reading.method, 'none');
    const reader = { read: async ({ mime }) => ({ lines: [{ description: 'Test gold leaf 30pcs/pack', quantity: 10, unitPrice: 90, amount: 900 }], total: 900, currency: 'RMB', marketplaceAsPrinted: 'USA', model: `fake for ${mime}` }) };
    const read = await intakeInvoice({ db, buffer: Buffer.from('%PDF-1.4 other'), filename: 'pi2.pdf', source: 'upload', actor: 'Ashar', reader, dir });
    assert.equal(read.reading.method, 'model');
    assert.equal(read.reading.lines[0].product, 'T30-US');
    await assert.rejects(intakeInvoice({ db, buffer: Buffer.from('x'), filename: 'notes.txt', source: 'upload', actor: 'Ashar', dir }), /Can't read/);
  } finally {
    done();
  }
});

