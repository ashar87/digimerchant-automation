// Rule tests for the landing-cost engine. Every figure here is made up;
// the real orders are tested in golden.test.js from a private fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLandingCosts } from '../../src/landing/engine.js';
import { fmt4 } from '../../src/landing/money.js';

const products = [
  { id: 'A-UK', code: 'A', marketplace: 'UK' },
  { id: 'B-UK', code: 'B', marketplace: 'UK' },
  { id: 'A-US', code: 'A', marketplace: 'US' },
  { id: 'A-DE', code: 'A', marketplace: 'DE' },
];

const order = (po, marketplace, lines, extra = {}) => ({
  po,
  supplier: 'Test Supplier',
  marketplace,
  invoices: [{ id: `${po}-final`, kind: 'final', date: '2026-01-10', lines }],
  ...extra,
});
const goods = (product, qty, rmb) => ({ kind: 'goods', product, qty, rmb });
const shipment = (id, marketplace, status, items, extra = {}) => ({ id, marketplace, status, createdAt: '2026-02-01', items, ...extra });

const run = (ledger) => computeLandingCosts({ products, orders: [], payments: [], courierBills: [], shipments: [], ...ledger });
const line = (r, po, product) => r.orders.find((o) => o.po === po).lines.find((l) => l.product === product);
const batch = (r, shipmentId, product) => r.batches.find((b) => b.shipment === shipmentId && b.product === product);
const codes = (r) => r.issues.map((i) => i.code);

test('a GBP payment covering two invoices is split by the USD each states', () => {
  const r = run({
    orders: [order('PO-1', 'UK', [goods('A-UK', 100, 1000)]), order('PO-2', 'UK', [goods('B-UK', 100, 3000)])],
    payments: [{
      id: 'P1', date: '2026-01-15', usd: 400, gbp: 300,
      allocations: [
        { type: 'order', target: 'PO-1', part: 'full', usd: 100 },
        { type: 'order', target: 'PO-2', part: 'full', usd: 300 },
      ],
    }],
  });
  assert.equal(fmt4(r.orders[0].cash), '75.0000');
  assert.equal(fmt4(r.orders[1].cash), '225.0000');
  assert.equal(fmt4(line(r, 'PO-1', 'A-UK').unitCost), '0.7500');
});

test('USD paid from the USD balance is converted at the QB rate for UK', () => {
  const r = run({
    orders: [order('PO-1', 'UK', [goods('A-UK', 100, 1000)])],
    payments: [{ id: 'P1', date: '2026-01-15', usd: 200, qbRate: '0.75', allocations: [{ type: 'order', target: 'PO-1', part: 'full', usd: 200 }] }],
  });
  assert.equal(fmt4(r.orders[0].cash), '150.0000');
});

test('EUR for DE is converted with the QB GBP-per-EUR rate', () => {
  const r = run({
    orders: [order('PO-1', 'DE', [goods('A-DE', 100, 1000)])],
    payments: [{ id: 'P1', date: '2026-01-15', eur: 100, qbRate: '0.85', allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }],
  });
  assert.equal(fmt4(r.orders[0].cash), '85.0000');
});

test('US is costed in the USD sent, never GBP, even when the deposit was paid in GBP', () => {
  // The gold-flakes mistake: a USD deposit added to a GBP balance.
  const r = run({
    orders: [order('PO-1', 'US', [goods('A-US', 100, 1000)])],
    payments: [
      { id: 'P1', date: '2026-01-15', usd: 100, gbp: 80, allocations: [{ type: 'order', target: 'PO-1', part: 'deposit', usd: 100 }] },
      { id: 'P2', date: '2026-01-25', usd: 200, qbRate: '0.75', allocations: [{ type: 'order', target: 'PO-1', part: 'balance', usd: 200 }] },
    ],
  });
  assert.equal(r.orders[0].currency, 'USD');
  assert.equal(fmt4(line(r, 'PO-1', 'A-US').unitCost), '3.0000');
});

test('a US order paid only in GBP is flagged, not guessed', () => {
  const r = run({
    orders: [order('PO-1', 'US', [goods('A-US', 100, 1000)])],
    payments: [{ id: 'P1', date: '2026-01-15', gbp: 80, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }],
  });
  assert.equal(line(r, 'PO-1', 'A-US').unitCost, null);
  assert.ok(codes(r).includes('payment_missing_currency'));
});

test('invoice lines: own labour per pack, fees and adjustments by RMB share, expenses excluded', () => {
  // Goods 3,000 + 1,000. Labour 30 on A only. Fee 40 and adjustment -20 shared 3:1.
  // Packing bags 950 are an expense. Total 5,000 RMB.
  const r = run({
    orders: [order('PO-1', 'UK', [
      goods('A-UK', 300, 3000),
      goods('B-UK', 100, 1000),
      { kind: 'labour', product: 'A-UK', rmb: 30 },
      { kind: 'fee', rmb: 40 },
      { kind: 'adjustment', rmb: -20 },
      { kind: 'expense', rmb: 950, category: 'Advertising' },
    ])],
    payments: [{ id: 'P1', date: '2026-01-15', gbp: 500, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }],
  });
  const a = line(r, 'PO-1', 'A-UK');
  const b = line(r, 'PO-1', 'B-UK');
  assert.equal(a.allocatedRmb.toString(), '3045'); // 3000 + 30 + 20 × 3/4
  assert.equal(b.allocatedRmb.toString(), '1005'); // 1000 + 20 × 1/4
  assert.equal(fmt4(a.cost), '304.5000'); // 500 × 3045/5000
  assert.equal(fmt4(b.cost), '100.5000');
  assert.equal(fmt4(a.cost.plus(b.cost)), '405.0000'); // the 95 for packing bags is not in landing cost
});

test('the final invoice replaces the proforma', () => {
  const o = order('PO-1', 'UK', [goods('A-UK', 100, 1200)]);
  o.invoices.unshift({ id: 'PO-1-proforma', kind: 'proforma', date: '2026-01-01', lines: [goods('A-UK', 100, 1000)] });
  const r = run({ orders: [o] });
  assert.equal(r.orders[0].invoice.id, 'PO-1-final');
  assert.equal(r.orders[0].totalRmb.toString(), '1200');
});

test('units: ordered until fully shipped and closed, then received', () => {
  const ledger = {
    orders: [order('PO-1', 'UK', [goods('A-UK', 800, 8000)])],
    payments: [{ id: 'P1', date: '2026-01-15', gbp: 800, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }],
    shipments: [shipment('FBA1', 'UK', 'CLOSED', [{ product: 'A-UK', po: 'PO-1', shipped: 750, received: 748 }])],
  };
  // 750 of 800 shipped: the 50 still in China keep their share.
  let l = line(run(ledger), 'PO-1', 'A-UK');
  assert.equal(l.basis, 'ordered');
  assert.equal(fmt4(l.unitCost), '1.0000');

  // Writing the 50 off moves their cost onto what arrived.
  ledger.orders[0].writeOffs = [{ product: 'A-UK', qty: 50, reason: 'never shipped' }];
  l = line(run(ledger), 'PO-1', 'A-UK');
  assert.equal(l.basis, 'received');
  assert.equal(fmt4(l.unitCost), fmt4(800 / 748));
});

test('a line in two shipments gets one unit cost, final only when both close', () => {
  const ledger = {
    orders: [order('PO-1', 'UK', [goods('A-UK', 1000, 10000)])],
    payments: [{ id: 'P1', date: '2026-01-15', gbp: 1000, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] }],
    shipments: [
      shipment('FBA1', 'UK', 'CLOSED', [{ product: 'A-UK', po: 'PO-1', shipped: 600, received: 598 }]),
      shipment('FBA2', 'UK', 'RECEIVING', [{ product: 'A-UK', po: 'PO-1', shipped: 400, received: 100 }]),
    ],
  };
  let r = run(ledger);
  assert.equal(fmt4(batch(r, 'FBA1', 'A-UK').productCost), '1.0000');
  assert.equal(fmt4(batch(r, 'FBA2', 'A-UK').productCost), '1.0000');

  ledger.shipments[1].status = 'CLOSED';
  ledger.shipments[1].items[0].received = 402;
  r = run(ledger);
  assert.equal(fmt4(batch(r, 'FBA1', 'A-UK').productCost), '1.0000'); // 1000 / (598 + 402)
  assert.equal(line(r, 'PO-1', 'A-UK').basis, 'received');
});

test('the same product from two orders in one shipment is averaged by units', () => {
  const r = run({
    orders: [order('PO-1', 'UK', [goods('A-UK', 100, 1000)]), order('PO-2', 'UK', [goods('A-UK', 300, 3000)])],
    payments: [
      { id: 'P1', date: '2026-01-15', gbp: 100, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] },
      { id: 'P2', date: '2026-01-16', gbp: 600, allocations: [{ type: 'order', target: 'PO-2', part: 'full' }] },
    ],
    shipments: [shipment('FBA1', 'UK', 'SHIPPED', [
      { product: 'A-UK', po: 'PO-1', shipped: 100 },
      { product: 'A-UK', po: 'PO-2', shipped: 300 },
    ])],
  });
  assert.equal(fmt4(batch(r, 'FBA1', 'A-UK').productCost), '1.7500'); // (100×1 + 300×2) / 400
});

test('courier bills: by shipment, shared fees by RMB share, USD for US and GBP for UK', () => {
  const r = run({
    shipments: [
      shipment('FBA-UK', 'UK', 'CLOSED', [{ product: 'A-UK', shipped: 100, received: 98 }]),
      shipment('FBA-US', 'US', 'SHIPPED', [{ product: 'A-US', shipped: 200 }]),
    ],
    courierBills: [{
      id: 'BILL-1', agent: 'Agent', date: '2026-02-10',
      lines: [
        { kind: 'shipping', shipment: 'FBA-UK', rmb: 500 },
        { kind: 'domestic', shipment: 'FBA-UK', rmb: 100 },
        { kind: 'shipping', shipment: 'FBA-US', rmb: 1800 },
        { kind: 'fee', rmb: 24 },
        { kind: 'adjustment', rmb: -24 },
        { kind: 'expense', rmb: 600, category: 'R&D' },
      ],
    }],
    payments: [{ id: 'P1', date: '2026-02-12', usd: 450, qbRate: '0.8', allocations: [{ type: 'bill', target: 'BILL-1', usd: 450 }] }],
  });
  const uk = r.shipments.find((s) => s.id === 'FBA-UK');
  const us = r.shipments.find((s) => s.id === 'FBA-US');
  // 3,000 RMB in all; UK 600, US 1,800, R&D 600.
  assert.equal(fmt4(uk.delivery.total), '72.0000'); // 450 × 0.8 × 600/3000
  assert.equal(fmt4(uk.delivery.perUnit), fmt4(72 / 98)); // closed: over units received
  assert.equal(fmt4(us.delivery.total), '270.0000'); // 450 × 1800/3000, in USD
  assert.equal(fmt4(us.delivery.perUnit), '1.3500'); // not closed: over units shipped
});

test('before the bill, delivery is estimated from the same product first, then the marketplace', () => {
  const billed = (id, product, createdAt, rmb) => ({ ...shipment(id, 'UK', 'CLOSED', [{ product, shipped: 100, received: 100 }]), createdAt });
  const r = run({
    shipments: [
      billed('OLD-A', 'A-UK', '2026-01-01', 100),
      billed('NEWER-B', 'B-UK', '2026-01-20', 200),
      shipment('OPEN-A', 'UK', 'SHIPPED', [{ product: 'A-UK', shipped: 50 }], { createdAt: '2026-02-01' }),
      shipment('OPEN-C', 'UK', 'SHIPPED', [{ product: 'X-UK', shipped: 50 }], { createdAt: '2026-02-01' }),
    ],
    courierBills: [{ id: 'B1', lines: [{ kind: 'shipping', shipment: 'OLD-A', rmb: 100 }, { kind: 'shipping', shipment: 'NEWER-B', rmb: 200 }] }],
    payments: [{ id: 'P1', date: '2026-01-25', gbp: 30, allocations: [{ type: 'bill', target: 'B1' }] }],
  });
  const openA = r.shipments.find((s) => s.id === 'OPEN-A').delivery;
  const openC = r.shipments.find((s) => s.id === 'OPEN-C').delivery;
  assert.equal(openA.basis, 'estimated');
  assert.equal(openA.estimatedFrom, 'OLD-A');
  assert.equal(fmt4(openA.perUnit), '0.1000');
  assert.equal(openC.estimatedFrom, 'NEWER-B');
  assert.equal(fmt4(openC.perUnit), '0.2000');
});

test('batch status follows payment, bill and Amazon count', () => {
  const base = () => ({
    orders: [order('PO-1', 'UK', [goods('A-UK', 100, 1000)])],
    payments: [
      { id: 'P1', date: '2026-01-15', gbp: 30, allocations: [{ type: 'order', target: 'PO-1', part: 'deposit', rmb: 300 }] },
      { id: 'P2', date: '2026-01-20', gbp: 70, allocations: [{ type: 'order', target: 'PO-1', part: 'balance', rmb: 700 }] },
      { id: 'P3', date: '2026-02-10', gbp: 10, allocations: [{ type: 'bill', target: 'B1' }] },
    ],
    courierBills: [{ id: 'B1', lines: [{ kind: 'shipping', shipment: 'FBA1', rmb: 100 }] }],
    shipments: [shipment('FBA1', 'UK', 'CLOSED', [{ product: 'A-UK', po: 'PO-1', shipped: 100, received: 100 }])],
  });
  assert.equal(batch(run(base()), 'FBA1', 'A-UK').status, 'final');

  const counting = base();
  counting.shipments[0].status = 'RECEIVING';
  assert.equal(batch(run(counting), 'FBA1', 'A-UK').status, 'count_pending');

  const noBill = base();
  noBill.courierBills = [];
  noBill.payments.pop();
  assert.equal(batch(run(noBill), 'FBA1', 'A-UK').status, 'estimated');

  const depositOnly = base();
  depositOnly.payments.splice(1, 1);
  const r = run(depositOnly);
  assert.equal(batch(r, 'FBA1', 'A-UK').status, 'provisional');
  // Projected from the deposit: 30 GBP for 300 of 1,000 RMB → 100 GBP.
  assert.equal(fmt4(line(r, 'PO-1', 'A-UK').unitCost), '1.0000');
});

test('checks: invoice arithmetic, courier rate, and payments that do not add up', () => {
  const o = order('PO-1', 'UK', [goods('A-UK', 100, 1000)]);
  o.invoices[0].statedTotalRmb = 1100;
  const r = run({
    orders: [o],
    shipments: [shipment('FBA1', 'UK', 'SHIPPED', [{ product: 'A-UK', po: 'PO-1', shipped: 100 }])],
    courierBills: [{ id: 'B1', agent: 'Agent', rmbPerUsd: '6.5', lines: [{ kind: 'shipping', shipment: 'FBA1', rmb: 1000 }] }],
    payments: [
      { id: 'P1', date: '2026-01-15', usd: 160, qbRate: '0.75', allocations: [{ type: 'order', target: 'PO-1', part: 'full', usd: 150 }] },
      { id: 'P2', date: '2026-02-15', usd: 160, qbRate: '0.75', allocations: [{ type: 'bill', target: 'B1', usd: 160 }] },
    ],
  });
  assert.ok(codes(r).includes('invoice_total_mismatch'));
  assert.ok(codes(r).includes('payment_allocation_mismatch'));
  const rate = r.issues.find((i) => i.code === 'bill_rate_mismatch');
  assert.match(rate.message, /\$6\.15/); // 160 − 1000 / 6.5
});

test('a one-shipment bill that states only USD carries all of it to that shipment', () => {
  const r = run({
    shipments: [shipment('FBA1', 'UK', 'SHIPPED', [{ product: 'A-UK', shipped: 200 }])],
    courierBills: [{ id: 'B1', lines: [{ kind: 'shipping', shipment: 'FBA1' }] }],
    payments: [{ id: 'P1', date: '2026-02-12', usd: 100, qbRate: '0.8', allocations: [{ type: 'bill', target: 'B1', usd: 100 }] }],
  });
  assert.equal(fmt4(r.shipments[0].delivery.perUnit), '0.4000');
  assert.ok(!codes(r).includes('bill_rmb_missing'));
});
