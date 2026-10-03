/**
 * Landing-cost engine.
 *
 * A pure function from source records (invoices, payments, courier bills,
 * shipments) to costs. Nothing is ever typed into a result: change a source
 * record and everything downstream is recomputed from scratch.
 *
 * Ledger shape (also what store.loadLedger returns):
 *
 *   products:     [{ id, code, marketplace, name, sku, asin, fnsku }]
 *   orders:       [{ po, supplier, marketplace,
 *                    invoices:  [{ id, kind: proforma|final, date, statedTotalRmb,
 *                                  lines: [{ kind, product, qty, rmb, description }] }],
 *                    writeOffs: [{ product, qty, reason }] }]
 *   payments:     [{ id, date, reference, usd, gbp, eur, qbRate, fee,
 *                    allocations: [{ type: order|bill|expense|credit|other, target,
 *                                    part: deposit|balance|full, usd, rmb, description }] }]
 *   courierBills: [{ id, agent, date, statedTotalRmb, rmbPerUsd,
 *                    lines: [{ kind, shipment, rmb, description }] }]
 *   shipments:    [{ id, marketplace, name, status, createdAt, firstReceivedAt,
 *                    items: [{ product, po, shipped, received }] }]
 *
 * Invoice line kinds: goods (needs product, qty) · labour (with a product it is
 * that product's own cost per pack; without, it is shared) · fee (Annie's 1%,
 * shared) · adjustment (rate differences, gold re-pricing, credits; shared) ·
 * expense (packing bags, samples, R&D: never in landing cost).
 *
 * Courier bill line kinds: shipping, domestic (with a shipment: that
 * shipment's own cost; without: shared) · fee, adjustment (shared) · expense.
 *
 * Shared amounts are spread by RMB share: across goods lines on an invoice,
 * across shipments on a courier bill.
 */
import { D, ZERO, ONE, sum, costCurrency, fmt4, fmtMoney, fmtRmb } from './money.js';

const CLOSED = 'CLOSED';
const IGNORED_SHIPMENT_STATUSES = new Set(['CANCELLED', 'DELETED']);
const SETTLING_PARTS = new Set(['balance', 'full']);
// An RMB difference smaller than this is rounding on the supplier's side, not money owed.
const RMB_TOLERANCE = D(1);
const USD_TOLERANCE = D(1);

export function computeLandingCosts(ledger) {
  const issues = [];
  const issue = (severity, code, ref, message) => issues.push({ severity, code, ref, message });

  const products = new Map((ledger.products || []).map((p) => [p.id, p]));
  const orders = ledger.orders || [];
  const payments = ledger.payments || [];
  const bills = ledger.courierBills || [];
  const shipments = (ledger.shipments || []).filter((s) => !IGNORED_SHIPMENT_STATUSES.has(s.status));

  const ordersByPo = new Map(orders.map((o) => [o.po, o]));
  const shipmentsById = new Map(shipments.map((s) => [s.id, s]));

  /* ---------- 1. payments: what each allocation cost, in USD and GBP ---------- */

  const allocationsByTarget = new Map(); // "order:PO-041" -> [{ payment, allocation, usd, gbp }]
  for (const p of payments) {
    for (const a of splitPayment(p, issue)) {
      const key = `${a.allocation.type}:${a.allocation.target}`;
      if (!allocationsByTarget.has(key)) allocationsByTarget.set(key, []);
      allocationsByTarget.get(key).push(a);
    }
  }
  const paidTo = (type, target) => allocationsByTarget.get(`${type}:${target}`) || [];

  for (const [key, list] of allocationsByTarget) {
    const [type, target] = splitKey(key);
    if (type === 'order' && !ordersByPo.has(target)) {
      issue('warning', 'payment_unknown_order', list[0].payment.id, `Payment ${list[0].payment.id} pays ${target}, which isn't an order on file.`);
    }
    if (type === 'bill' && !bills.some((b) => b.id === target)) {
      issue('warning', 'payment_unknown_bill', list[0].payment.id, `Payment ${list[0].payment.id} pays courier bill ${target}, which isn't on file.`);
    }
  }

  /* ---------- 2. courier bills: delivery cost per shipment ---------- */

  const billedDelivery = new Map(); // shipmentId -> [{ bill, amount, rmb, share }]
  for (const bill of bills) {
    for (const entry of allocateBill(bill, paidTo('bill', bill.id), shipmentsById, issue)) {
      if (!billedDelivery.has(entry.shipment)) billedDelivery.set(entry.shipment, []);
      billedDelivery.get(entry.shipment).push(entry);
    }
  }

  /* ---------- 3. orders: product cost per order line ---------- */

  const itemsByOrderProduct = new Map(); // "PO|product" -> [{ shipment, item }]
  for (const s of shipments) {
    for (const item of s.items || []) {
      if (!item.po) continue;
      const key = `${item.po}|${item.product}`;
      if (!itemsByOrderProduct.has(key)) itemsByOrderProduct.set(key, []);
      itemsByOrderProduct.get(key).push({ shipment: s, item });
    }
  }

  const orderResults = new Map();
  for (const order of orders) {
    orderResults.set(order.po, costOrder(order, paidTo('order', order.po), itemsByOrderProduct, issue));
  }

  /* ---------- 4. shipments: delivery per unit, billed or estimated ---------- */

  const shipmentResults = new Map();
  for (const s of shipments) {
    const closed = s.status === CLOSED;
    const items = s.items || [];
    const shippedUnits = sum(items.map((i) => D(i.shipped)));
    const receivedUnits = sum(items.map((i) => D(i.received)));
    const units = closed ? receivedUnits : shippedUnits;
    const currency = costCurrency(s.marketplace);

    const billed = billedDelivery.get(s.id) || [];
    let delivery;
    if (billed.length && billed.every((b) => b.amount !== null)) {
      const total = sum(billed.map((b) => b.amount));
      delivery = {
        basis: 'billed',
        total,
        perUnit: units.gt(0) ? total.div(units) : null,
        units,
        unitsBasis: closed ? 'received' : 'shipped',
        bills: billed.map((b) => ({ bill: b.bill, amount: b.amount, rmb: b.rmb, share: b.share })),
      };
      if (units.lte(0)) issue('error', 'shipment_no_units', s.id, `${s.id} has a courier cost but no units to spread it over.`);
    } else {
      delivery = { basis: 'none', total: null, perUnit: null, units, unitsBasis: closed ? 'received' : 'shipped', bills: [] };
    }
    shipmentResults.set(s.id, { id: s.id, marketplace: s.marketplace, currency, status: s.status, closed, shippedUnits, receivedUnits, delivery });
  }

  // Before a courier bill arrives, borrow the most recent actual: first from a
  // shipment carrying the same product to the same marketplace, then any.
  for (const s of shipments) {
    const r = shipmentResults.get(s.id);
    if (r.delivery.basis === 'billed') continue;
    const source = estimateSource(s, shipments, shipmentResults);
    if (source) {
      const src = shipmentResults.get(source.id);
      r.delivery = {
        ...r.delivery,
        basis: 'estimated',
        perUnit: src.delivery.perUnit,
        total: r.delivery.units.gt(0) ? src.delivery.perUnit.times(r.delivery.units) : null,
        estimatedFrom: source.id,
        estimateMatch: source.match,
      };
    } else {
      issue('info', 'no_delivery_estimate', s.id, `${s.id} has no courier bill yet and no earlier ${s.marketplace} shipment to estimate from.`);
    }
  }

  /* ---------- 5. batches: one per product per shipment ---------- */

  const batches = [];
  for (const s of shipments) {
    const sr = shipmentResults.get(s.id);
    const byProduct = new Map();
    for (const item of s.items || []) {
      if (!byProduct.has(item.product)) byProduct.set(item.product, []);
      byProduct.get(item.product).push(item);
    }
    for (const [productId, items] of byProduct) {
      batches.push(costBatch(s, sr, productId, items, products, orderResults, issue));
    }
  }

  return {
    orders: [...orderResults.values()],
    shipments: [...shipmentResults.values()],
    batches,
    issues,
  };
}

/* ======================================================================== */

/**
 * Splits one payment across what it paid for. Weights are the USD each invoice
 * states; failing that, RMB. GBP for UK/DE is the GBP actually paid, or the
 * USD/EUR × the QB rate on the payment date.
 */
function splitPayment(p, issue) {
  const allocations = p.allocations || [];
  if (!allocations.length) {
    issue('warning', 'payment_unallocated', p.id, `Payment ${p.id} isn't linked to any order or bill.`);
    return [];
  }

  const usd = D(p.usd);
  const rate = D(p.qbRate);
  let gbpTotal = D(p.gbp);
  if (gbpTotal === null && D(p.eur) !== null && rate !== null) gbpTotal = D(p.eur).times(rate);
  if (gbpTotal === null && usd !== null && rate !== null) gbpTotal = usd.times(rate);

  let weights;
  if (allocations.every((a) => D(a.usd) !== null)) weights = allocations.map((a) => D(a.usd));
  else if (allocations.length === 1) weights = [ONE];
  else if (allocations.every((a) => D(a.rmb) !== null)) weights = allocations.map((a) => D(a.rmb));
  else {
    issue('error', 'payment_split_unknown', p.id, `Payment ${p.id} covers ${allocations.length} things but not every one states its USD or RMB, so it can't be split.`);
    return allocations.map((allocation) => ({ payment: p, allocation, usd: D(allocation.usd), gbp: null }));
  }
  const totalWeight = sum(weights);

  if (usd !== null && allocations.every((a) => D(a.usd) !== null)) {
    const diff = usd.minus(totalWeight);
    if (diff.abs().gt(USD_TOLERANCE)) {
      issue('warning', 'payment_allocation_mismatch', p.id, `Payment ${p.id} sent $${fmtMoney(usd)} but its links add up to $${fmtMoney(totalWeight)} (difference $${fmtMoney(diff)}).`);
    }
  }

  return allocations.map((allocation, i) => {
    const share = totalWeight.gt(0) ? weights[i].div(totalWeight) : null;
    const allocUsd = D(allocation.usd) ?? (usd !== null && share !== null ? usd.times(share) : null);
    const allocGbp = gbpTotal !== null && share !== null ? gbpTotal.times(share) : null;
    return { payment: p, allocation, share, usd: allocUsd, gbp: allocGbp };
  });
}

const amountIn = (a, currency) => (currency === 'USD' ? a.usd : a.gbp);

/** Spreads shared RMB across keys in proportion to their weights. */
function spread(ownByKey, weightByKey, shared) {
  const totalWeight = sum([...weightByKey.values()]);
  const out = new Map();
  for (const [key, own] of ownByKey) {
    const w = weightByKey.get(key) || ZERO;
    out.set(key, own.plus(totalWeight.gt(0) ? shared.times(w).div(totalWeight) : ZERO));
  }
  return out;
}

/* ---------------------------- orders ---------------------------- */

function chooseInvoice(order) {
  const invoices = order.invoices || [];
  const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || ''));
  const finals = invoices.filter((i) => i.kind === 'final').sort(byDate);
  if (finals.length) return finals[finals.length - 1];
  const proformas = invoices.filter((i) => i.kind !== 'final').sort(byDate);
  return proformas[proformas.length - 1] || null;
}

function costOrder(order, allocations, itemsByOrderProduct, issue) {
  const currency = costCurrency(order.marketplace);
  const invoice = chooseInvoice(order);
  const result = {
    po: order.po,
    supplier: order.supplier,
    marketplace: order.marketplace,
    currency,
    invoice: invoice ? { id: invoice.id, kind: invoice.kind, date: invoice.date } : null,
    totalRmb: null,
    paidRmb: null,
    cash: null,
    costBasis: null,
    paidStatus: 'unpaid',
    payments: allocations.map((a) => ({
      payment: a.payment.id,
      date: a.payment.date,
      reference: a.payment.reference,
      part: a.allocation.part,
      rmb: D(a.allocation.rmb),
      amount: amountIn(a, currency),
    })),
    lines: [],
  };
  if (!invoice) {
    issue('error', 'order_no_invoice', order.po, `${order.po} has no invoice.`);
    return result;
  }

  const lines = invoice.lines || [];
  const goods = lines.filter((l) => l.kind === 'goods');
  if (!goods.length) {
    issue('error', 'invoice_no_goods', order.po, `The ${invoice.kind} invoice on ${order.po} has no product lines.`);
    return result;
  }

  // RMB: the lines are the truth; a stated total that disagrees is flagged, not used.
  const allLinesHaveRmb = lines.every((l) => D(l.rmb) !== null);
  const linesTotal = allLinesHaveRmb ? sum(lines.map((l) => D(l.rmb))) : null;
  const stated = D(invoice.statedTotalRmb);
  result.totalRmb = linesTotal ?? stated;
  if (linesTotal !== null && stated !== null && linesTotal.minus(stated).abs().gt(RMB_TOLERANCE)) {
    issue('warning', 'invoice_total_mismatch', order.po, `${order.po}: the invoice says ${fmtRmb(stated)} RMB but its lines add up to ${fmtRmb(linesTotal)} RMB.`);
  }

  // Each product's share of the invoice: its goods, its own labour, and its
  // share (by goods RMB) of fees, shared labour and adjustments.
  const goodsByProduct = new Map();
  for (const l of goods) {
    const g = goodsByProduct.get(l.product) || { qty: ZERO, rmb: ZERO, rmbKnown: true };
    g.qty = g.qty.plus(D(l.qty) ?? ZERO);
    if (D(l.rmb) === null) g.rmbKnown = false;
    else g.rmb = g.rmb.plus(D(l.rmb));
    goodsByProduct.set(l.product, g);
  }

  let fractions; // product -> Decimal share of the invoice's total RMB
  if (allLinesHaveRmb && result.totalRmb.gt(0)) {
    const own = new Map([...goodsByProduct].map(([p, g]) => [p, g.rmb]));
    for (const l of lines) {
      if (l.kind === 'labour' && l.product) {
        if (!own.has(l.product)) issue('warning', 'labour_unknown_product', order.po, `${order.po}: labour line for ${l.product}, which isn't a product on the invoice.`);
        else own.set(l.product, own.get(l.product).plus(D(l.rmb)));
      }
    }
    const shared = sum(lines.filter((l) => ['fee', 'adjustment'].includes(l.kind) || (l.kind === 'labour' && !l.product)).map((l) => D(l.rmb)));
    const weights = new Map([...goodsByProduct].map(([p, g]) => [p, g.rmb]));
    const allocated = spread(own, weights, shared);
    fractions = new Map([...allocated].map(([p, rmb]) => [p, { rmb, fraction: rmb.div(result.totalRmb) }]));
  } else if (goodsByProduct.size === 1 && lines.every((l) => l.kind === 'goods' || l.kind === 'fee' || l.kind === 'adjustment' || l.kind === 'labour')) {
    // One product and nothing excluded: it carries the whole invoice.
    const [p] = goodsByProduct.keys();
    fractions = new Map([[p, { rmb: result.totalRmb, fraction: ONE }]]);
  } else {
    issue('error', 'invoice_rmb_missing', order.po, `${order.po}: the invoice has several lines but not all have an RMB amount, so they can't be split.`);
    fractions = new Map();
  }

  // Cash. US is costed in the USD sent; UK and DE in GBP.
  const amounts = allocations.map((a) => amountIn(a, currency));
  if (allocations.length && amounts.some((x) => x === null)) {
    issue('error', 'payment_missing_currency', order.po, `${order.po} is costed in ${currency}, but a payment towards it has no ${currency} amount${currency === 'GBP' ? ' or QB rate' : ''}.`);
  }
  const cash = allocations.length && amounts.every((x) => x !== null) ? sum(amounts) : null;
  result.cash = cash;

  const rmbs = allocations.map((a) => D(a.allocation.rmb));
  result.paidRmb = allocations.length && rmbs.every((x) => x !== null) ? sum(rmbs) : null;

  if (allocations.length) {
    const settled =
      allocations.some((a) => SETTLING_PARTS.has(a.allocation.part)) ||
      (result.paidRmb !== null && result.totalRmb !== null && result.paidRmb.gte(result.totalRmb.minus(RMB_TOLERANCE)));
    result.paidStatus = settled ? 'paid' : 'deposit_paid';
    if (settled && result.paidRmb !== null && result.totalRmb !== null) {
      const diff = result.paidRmb.minus(result.totalRmb);
      if (diff.abs().gt(RMB_TOLERANCE)) {
        issue('warning', 'order_rmb_mismatch', order.po, `${order.po}: payments cover ${fmtRmb(result.paidRmb)} RMB against an invoice of ${fmtRmb(result.totalRmb)} RMB (${diff.gt(0) ? 'over' : 'under'} by ${fmtRmb(diff.abs())}).`);
      }
    }
  }

  // Until the balance is paid, project the full cost from the deposit's rate.
  let costBasis = null;
  if (result.paidStatus === 'paid') costBasis = cash;
  else if (result.paidStatus === 'deposit_paid' && cash !== null && result.paidRmb?.gt(0) && result.totalRmb !== null) {
    costBasis = cash.times(result.totalRmb).div(result.paidRmb);
  }
  result.costBasis = costBasis;

  const writeOffs = order.writeOffs || [];
  for (const [product, g] of goodsByProduct) {
    const f = fractions.get(product);
    const lineCost = costBasis !== null && f ? costBasis.times(f.fraction) : null;
    const units = lineUnits(order.po, product, g.qty, itemsByOrderProduct, writeOffs);
    const unitCost = lineCost !== null && units.divisor.gt(0) ? lineCost.div(units.divisor) : null;
    if (units.basis === 'received' && units.divisor.lte(0)) {
      issue('error', 'line_nothing_received', order.po, `${order.po} ${product}: every shipment has closed with nothing received.`);
    }
    result.lines.push({
      product,
      ordered: g.qty,
      rmb: g.rmbKnown ? g.rmb : null,
      allocatedRmb: f?.rmb ?? null,
      fraction: f?.fraction ?? null,
      cost: lineCost,
      projected: result.paidStatus === 'deposit_paid',
      ...units,
      unitCost,
    });
  }
  return result;
}

/**
 * Units ordered until the line has fully shipped and every shipment carrying
 * it has closed; then units Amazon received. Units that never ship keep their
 * share of the cost until they are written off.
 */
function lineUnits(po, product, ordered, itemsByOrderProduct, writeOffs) {
  const carried = itemsByOrderProduct.get(`${po}|${product}`) || [];
  const shipped = sum(carried.map(({ item }) => D(item.shipped)));
  const received = sum(carried.map(({ item }) => D(item.received)));
  const writtenOff = sum(writeOffs.filter((w) => w.product === product).map((w) => D(w.qty)));
  const allClosed = carried.length > 0 && carried.every(({ shipment }) => shipment.status === CLOSED);
  const fullyShipped = shipped.plus(writtenOff).gte(ordered);
  const final = allClosed && fullyShipped;
  return {
    shipped,
    received,
    writtenOff,
    shipments: carried.map(({ shipment }) => shipment.id),
    divisor: final ? received : ordered,
    basis: final ? 'received' : 'ordered',
  };
}

/* ---------------------------- courier bills ---------------------------- */

function allocateBill(bill, allocations, shipmentsById, issue) {
  let lines = bill.lines || [];
  // A bill for one shipment that states only USD carries all of it to that shipment.
  const wholeBill = lines.length === 1 && lines[0].shipment && D(lines[0].rmb) === null;
  if (wholeBill) lines = [{ ...lines[0], rmb: 1 }];
  if (lines.some((l) => D(l.rmb) === null)) {
    issue('error', 'bill_rmb_missing', bill.id, `Courier bill ${bill.id} has a line without an RMB amount.`);
    return [];
  }
  const totalRmb = sum(lines.map((l) => D(l.rmb)));
  const stated = D(bill.statedTotalRmb);
  if (!wholeBill && stated !== null && stated.minus(totalRmb).abs().gt(RMB_TOLERANCE)) {
    issue('warning', 'bill_total_mismatch', bill.id, `Courier bill ${bill.id} states ${fmtRmb(stated)} RMB but its lines add up to ${fmtRmb(totalRmb)} RMB.`);
  }

  const own = new Map();
  for (const l of lines) {
    if (!l.shipment || l.kind === 'expense') continue;
    own.set(l.shipment, (own.get(l.shipment) || ZERO).plus(D(l.rmb)));
  }
  const shared = sum(lines.filter((l) => !l.shipment && l.kind !== 'expense').map((l) => D(l.rmb)));
  const allocated = spread(own, own, shared);

  if (!allocations.length) {
    issue('info', 'bill_unpaid', bill.id, `Courier bill ${bill.id} has no payment linked yet.`);
  }
  const paidUsd = allocations.length && allocations.every((a) => a.usd !== null) ? sum(allocations.map((a) => a.usd)) : null;
  const paidGbp = allocations.length && allocations.every((a) => a.gbp !== null) ? sum(allocations.map((a) => a.gbp)) : null;

  const rate = D(bill.rmbPerUsd);
  if (!wholeBill && rate !== null && paidUsd !== null) {
    const expected = totalRmb.div(rate);
    const diff = paidUsd.minus(expected);
    if (diff.abs().gt(USD_TOLERANCE)) {
      issue('warning', 'bill_rate_mismatch', bill.id, `Courier bill ${bill.id}: $${fmtMoney(paidUsd)} billed, but ${fmtRmb(totalRmb)} RMB at ${rate} is $${fmtMoney(expected)}. $${fmtMoney(diff.abs())} to raise with ${bill.agent || 'the agent'}.`);
    }
  }

  const out = [];
  for (const [shipmentId, rmb] of allocated) {
    const s = shipmentsById.get(shipmentId);
    if (!s) {
      issue('info', 'bill_unknown_shipment', bill.id, `Courier bill ${bill.id} names ${shipmentId}, which isn't a shipment on file.`);
      continue;
    }
    const currency = costCurrency(s.marketplace);
    const paid = currency === 'USD' ? paidUsd : paidGbp;
    const share = totalRmb.gt(0) ? rmb.div(totalRmb) : null;
    if (allocations.length && paid === null) {
      issue('error', 'bill_missing_currency', bill.id, `Courier bill ${bill.id} covers a ${s.marketplace} shipment but its payment has no ${currency} amount${currency === 'GBP' ? ' or QB rate' : ''}.`);
    }
    out.push({ shipment: shipmentId, bill: bill.id, rmb: wholeBill ? null : rmb, share, amount: paid !== null && share !== null ? paid.times(share) : null });
  }
  return out;
}

function estimateSource(s, shipments, shipmentResults) {
  const products = new Set((s.items || []).map((i) => i.product));
  const candidates = shipments.filter((c) => {
    if (c.id === s.id || c.marketplace !== s.marketplace) return false;
    const r = shipmentResults.get(c.id);
    if (r.delivery.basis !== 'billed' || r.delivery.perUnit === null) return false;
    return !s.createdAt || !c.createdAt || c.createdAt <= s.createdAt;
  });
  const newestFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  const sameProduct = candidates.filter((c) => (c.items || []).some((i) => products.has(i.product))).sort(newestFirst);
  if (sameProduct.length) return { id: sameProduct[0].id, match: 'product' };
  const any = [...candidates].sort(newestFirst);
  return any.length ? { id: any[0].id, match: 'marketplace' } : null;
}

/* ---------------------------- batches ---------------------------- */

function costBatch(s, sr, productId, items, products, orderResults, issue) {
  const product = products.get(productId);
  if (!product) issue('warning', 'unknown_product', s.id, `${s.id} carries ${productId}, which isn't in the product list.`);

  const parts = items.map((item) => {
    const order = item.po ? orderResults.get(item.po) : null;
    const line = order?.lines.find((l) => l.product === productId) || null;
    if (!item.po) issue('warning', 'shipment_unlinked', s.id, `${s.id} ${productId} isn't linked to an order.`);
    else if (!order) issue('error', 'shipment_unknown_order', s.id, `${s.id} ${productId} is linked to ${item.po}, which isn't on file.`);
    else if (!line) issue('error', 'shipment_product_not_on_order', s.id, `${s.id} carries ${productId}, but ${item.po}'s invoice has no line for it.`);
    const units = sr.closed ? D(item.received) ?? ZERO : D(item.shipped) ?? ZERO;
    return { po: item.po || null, shipped: D(item.shipped), received: D(item.received), units, unitCost: line?.unitCost ?? null, order, line };
  });

  const shipped = sum(parts.map((p) => p.shipped));
  const received = sr.closed ? sum(parts.map((p) => p.received)) : null;
  const units = sr.closed ? received : shipped;

  // Same product from two orders in one shipment: averaged by units.
  let productCost = null;
  if (parts.every((p) => p.unitCost !== null)) {
    const weightOf = (p) => (p.units.gt(0) ? p.units : p.shipped ?? ZERO);
    const totalWeight = sum(parts.map(weightOf));
    productCost = parts.length === 1 ? parts[0].unitCost : totalWeight.gt(0) ? sum(parts.map((p) => p.unitCost.times(weightOf(p)))).div(totalWeight) : null;
  }
  const deliveryCost = sr.delivery.perUnit;
  const landingCost = productCost !== null && deliveryCost !== null ? productCost.plus(deliveryCost) : null;

  let status;
  if (productCost === null) status = 'incomplete';
  else if (parts.some((p) => p.order?.paidStatus !== 'paid')) status = 'provisional';
  else if (sr.delivery.basis !== 'billed') status = 'estimated';
  else if (!sr.closed || parts.some((p) => p.line?.basis !== 'received')) status = 'count_pending';
  else status = 'final';

  return {
    shipment: s.id,
    product: productId,
    code: product?.code ?? null,
    marketplace: s.marketplace,
    currency: sr.currency,
    shipmentStatus: s.status,
    batchDate: s.firstReceivedAt || null,
    shipped,
    received,
    units,
    productCost,
    deliveryCost,
    deliveryBasis: sr.delivery.basis,
    landingCost,
    status,
    orders: parts.map((p) => p.po),
    working: working(s, sr, parts, productCost, landingCost),
  };
}

/** The derivation behind a batch, step by step, as the dashboard will show it. */
function working(s, sr, parts, productCost, landingCost) {
  const sym = sr.currency === 'USD' ? '$' : '£';
  const money = (v) => (v === null ? '—' : `${sym}${fmtMoney(v)}`);
  const unit = (v) => (v === null ? '—' : `${sym}${fmt4(v)}`);
  const steps = [];

  for (const p of parts) {
    const o = p.order;
    const l = p.line;
    if (!o || !l) continue;
    const prefix = parts.length > 1 ? `${o.po}: ` : '';
    if (o.payments.length) {
      const paid = o.payments.map((x) => `${money(x.amount)} (${x.date})`).join(' + ');
      steps.push({ label: `${prefix}Paid on ${o.po}`, text: o.payments.length > 1 ? `${paid} = ${money(o.cash)}` : paid });
    }
    if (o.paidRmb !== null && o.totalRmb !== null) {
      const ok = o.paidRmb.minus(o.totalRmb).abs().lte(RMB_TOLERANCE);
      const rmbs = o.payments.map((x) => fmtRmb(x.rmb)).join(' + ');
      steps.push({ label: `${prefix}Covers`, text: `${rmbs} = ${fmtRmb(o.paidRmb)} RMB${ok ? ', matches the invoice ✓' : ` against ${fmtRmb(o.totalRmb)} on the invoice`}` });
    }
    if (l.fraction !== null && !l.fraction.eq(1)) {
      steps.push({ label: `${prefix}This line's share`, text: `${l.fraction.times(100).toFixed(2)}% of the invoice's RMB` });
      steps.push({ label: `${prefix}Line cost`, text: `${money(o.costBasis)} × ${l.fraction.times(100).toFixed(2)}% = ${money(l.cost)}` });
    }
    if (l.projected) steps.push({ label: `${prefix}Projected`, text: 'Only the deposit is paid; the full cost is projected at the deposit’s rate.' });
    steps.push({ label: `${prefix}Product cost / unit`, text: `${money(l.cost)} ÷ ${fmtRmb(l.divisor)} ${l.basis === 'received' ? 'received' : 'ordered'} = ${unit(l.unitCost)}` });
  }
  if (parts.length > 1) steps.push({ label: 'Product cost / unit', text: `averaged by units = ${unit(productCost)}` });

  const d = sr.delivery;
  if (d.basis === 'billed') {
    steps.push({ label: 'Delivery / unit', text: `${money(d.total)} (${d.bills.map((b) => b.bill).join(', ')}) ÷ ${fmtRmb(d.units)} ${d.unitsBasis} = ${unit(d.perUnit)}` });
  } else if (d.basis === 'estimated') {
    steps.push({ label: 'Delivery / unit', text: `${unit(d.perUnit)} estimated from ${d.estimatedFrom}${d.estimateMatch === 'product' ? ' (same product)' : ''}` });
  } else {
    steps.push({ label: 'Delivery / unit', text: 'no courier bill yet' });
  }
  steps.push({ label: 'Landing cost', text: unit(landingCost) });
  return steps;
}

function splitKey(key) {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}
