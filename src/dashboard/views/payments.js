import { html, select, money } from '../html.js';
import { documentsSection } from './files.js';
import { saveLedger, deleteRecord } from '../../landing/store.js';
import { computeLandingCosts } from '../../landing/engine.js';
import { queueBillCards } from '../../notify/bills.js';
import { text, number, date, required, rows, compact, uniqueId } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { enc } from './common.js';
import { history } from './orders.js';
import { versionField, assertFresh } from '../versions.js';
import { paymentFromTransfer } from '../../wise/import.js';
import { paymentsNeedingRate } from '../../quickbooks/rates.js';

const TYPES = [
  { value: 'order', label: 'Order (PO)' },
  { value: 'bill', label: 'Courier bill' },
  { value: 'expense', label: 'Expense' },
  { value: 'credit', label: 'Credit carried forward' },
  { value: 'other', label: 'Other (not costed here)' },
];
const PARTS = [
  { value: '', label: 'Choose…' },
  { value: 'deposit', label: 'Deposit' },
  { value: 'balance', label: 'Balance' },
  { value: 'full', label: 'Full payment' },
];
const BLANK_ROWS = 4;
// Suppliers take 30% up front and 70% before shipping: what "Pay deposit" fills in.
export const DEPOSIT_SHARE = '0.3';

/**
 * What "Pay deposit" / "Pay balance" / "Pay in full" on an order page fill in:
 * the part, the RMB the invoice asks for, and a Wise reference. Null when the
 * order's invoice total isn't known yet.
 */
export function presetFor(result, po, part) {
  const r = result.orders.find((o) => o.po === po);
  if (!r || !['deposit', 'balance', 'full'].includes(part)) return null;
  const total = r.totalRmb;
  let rmb = null;
  if (total !== null && total !== undefined) {
    if (part === 'deposit') rmb = total.times(DEPOSIT_SHARE).toDecimalPlaces(2);
    else if (part === 'balance') rmb = total.minus(r.paidRmb || 0).toDecimalPlaces(2);
    else rmb = total;
  }
  const reference = { deposit: `${po} 30%`, balance: `${po} balance`, full: `${po} full` }[part];
  return { part, rmb: rmb && rmb.gt(0) ? rmb.toString() : null, total, reference };
}

export function paymentsPage(ctx) {
  const { ledger } = ctx.data;
  const body = html`
<h1>Payments</h1>
<p class="sub">Every Wise transfer, its rate, and what it paid for. The PO goes in the Wise reference.</p>
<p><a class="button" href="/payments/new">Record a payment</a> <a href="/wise" style="margin-left:10px">From Wise</a></p>
<div class="card scroll"><table>
<thead><tr><th>Date</th><th>Payment</th><th>Reference</th><th class="n key">USD</th><th class="n">GBP / EUR</th><th class="n">QB rate</th><th>Paid for</th></tr></thead>
<tbody>${[...ledger.payments].reverse().map((p) => html`<tr><td>${p.date}</td><td><a href="/payments/${enc(p.id)}">${p.id}</a></td><td>${p.reference || ''}</td>
<td class="n">${money(p.usd, 'USD')}</td><td class="n">${p.gbp ? money(p.gbp, 'GBP') : p.eur ? money(p.eur, 'EUR') : '—'}</td><td class="n">${p.qbRate || '—'}</td>
<td class="small">${(p.allocations || []).map((a, i) => html`${i ? ', ' : ''}${a.type === 'order' ? html`<a href="/orders/${enc(a.target)}">${a.target}</a>` : a.type === 'bill' ? html`<a href="/bills/${enc(a.target)}">${a.target}</a>` : a.target || a.type}${a.part ? ` ${a.part}` : ''}`)}</td></tr>`)}
</tbody></table></div>`;
  return { title: 'Payments', body };
}

/**
 * The payment form. `values` and `error`: a save that was refused comes back
 * here with what was typed still filled in and the reason at the top, rather
 * than on a separate page.
 */
export function paymentForm(ctx, { values = null, error = null } = {}) {
  const { ledger } = ctx.data;
  const id = ctx.params[0];
  let p = id ? ledger.payments.find((x) => x.id === id) : null;
  if (id && !p) throw notFound(`Payment ${id}`);
  const existing = p;
  if (values) p = { ...values, id: existing?.id || null };
  const preset = ctx.url.searchParams.get('po');
  const wiseId = ctx.url.searchParams.get('wise');
  const wise = !p && wiseId ? ctx.db.prepare('SELECT * FROM wise_transfers WHERE id = ?').get(wiseId) : null;
  const fromWise = wise ? paymentFromTransfer(wise) : null;
  if (fromWise) p = { ...fromWise, id: null };
  const quick = !p && preset ? presetFor(ctx.data.result, preset, ctx.url.searchParams.get('part')) : null;
  if (quick) p = { reference: quick.reference };
  // "Pay bill" on a courier bill: the bill and its RMB filled in.
  const billId = !p ? ctx.url.searchParams.get('bill') : null;
  const bill = billId ? ledger.courierBills.find((b) => b.id === billId) : null;
  if (billId && !bill) throw notFound(`Courier bill ${billId}`);
  if (bill) p = { reference: `${bill.id} shipping` };
  const billUsd = bill && bill.statedTotalRmb && Number(bill.rmbPerUsd) > 0 ? (Number(bill.statedTotalRmb) / Number(bill.rmbPerUsd)).toFixed(2) : null;
  const allocations = [...(p?.allocations || (fromWise?.allocation ? [fromWise.allocation] : preset ? [{ type: 'order', target: preset, part: quick?.part, rmb: quick?.rmb }] : bill ? [{ type: 'bill', target: bill.id, rmb: bill.statedTotalRmb }] : []))];
  for (let i = 0; i < BLANK_ROWS; i++) allocations.push({});
  const targets = [
    ...ledger.orders.map((o) => o.po),
    ...ledger.courierBills.map((b) => b.id),
  ];

  const body = html`
<p class="muted small"><a href="/payments">Payments</a></p>
<h1>${p?.id ? `Payment ${p.id}` : 'Record a payment'}</h1>
${fromWise ? html`<p class="notice">Filled in from the Wise transfer of ${fromWise.date}${fromWise.reference ? ` (“${fromWise.reference}”)` : ''}. Check the amounts against Wise and say what it paid for.</p>` : ''}
${error ? html`<div class="notice" role="alert" style="background:var(--bad-bg);color:var(--bad)"><b>Not saved.</b> ${/[.!?)]$/.test(error) ? error : `${error}.`} Everything you typed is still below.</div>` : ''}
${existing ? rateStatus(ctx, existing) : ''}
${bill ? html`<p class="notice">Paying courier bill <a href="/bills/${enc(bill.id)}">${bill.id}</a>: ${Number(bill.statedTotalRmb || 0).toLocaleString('en-GB')} RMB${billUsd ? ` at ${bill.rmbPerUsd} = about $${billUsd}` : ''}. Add the date, the USD you sent and what it cost you (GBP, or EUR with the QB rate), then record it.${bill.lines.some((l) => l.shipment && ['UK', 'DE'].includes(ctx.data.ledger.shipments.find((s) => s.id === l.shipment)?.marketplace)) ? ' It covers UK or DE shipments, so they need the GBP (or the QB rate).' : ''}</p>` : ''}
${quick ? html`<p class="notice">${{ deposit: 'Deposit', balance: 'Balance', full: 'Full payment' }[quick.part]} for <a href="/orders/${enc(preset)}">${preset}</a>${quick.rmb ? html`: ${Number(quick.rmb).toLocaleString('en-GB')} RMB${quick.part === 'deposit' ? ' (30% of the invoice)' : quick.part === 'balance' ? ' (what’s still unpaid)' : ' (the whole invoice)'} is filled in. Change it if the supplier asked for a different amount, then add what you sent.` : html`. The invoice total isn’t known yet, so fill in the amount the supplier asked for.`}</p>` : ''}
<form class="card" method="post" action="/payments${p?.id ? `/${enc(p.id)}` : ''}" data-payment data-gbp-pos="${ledger.orders.filter((o) => o.marketplace !== 'US').map((o) => o.po).join(' ')}">
${fromWise || values?.wise ? html`<input type="hidden" name="wise" value="${fromWise?.wise || values.wise}">` : ''}
${existing ? (values ? html`<input type="hidden" name="version" value="${values.version || ''}">` : versionField(existing)) : ''}
<div class="grid">
  <div><label>Date (required)</label><input type="date" name="date" value="${p?.date || ''}" required></div>
  <div><label>Wise reference (required)</label><input name="reference" value="${p?.reference || ''}" placeholder="PO-020 30%" required></div>
  <div><label>USD sent</label><input name="usd" inputmode="decimal" data-one-of="sent" value="${p?.usd || ''}"></div>
  <div><label>GBP actually paid</label><input name="gbp" inputmode="decimal" data-one-of="sent" value="${p?.gbp || ''}"></div>
  <div><label>EUR sent</label><input name="eur" inputmode="decimal" data-one-of="sent" value="${p?.eur || ''}"></div>
  <div><label>QB rate (GBP per USD or EUR; required for UK/DE orders paid from USD or EUR)</label><input name="qbRate" inputmode="decimal" value="${p?.qbRate || ''}"></div>
  <div><label>Wise fee (expense)</label><input name="fee" inputmode="decimal" value="${p?.fee || ''}"></div>
  <div><label>Funded from</label><input name="funding" value="${p?.funding || ''}" placeholder="USD balance / GBP / EUR"></div>
</div>
<p class="muted small">UK and DE are costed in GBP: the GBP actually paid if you paid in GBP, otherwise USD or EUR × the QB rate on this date. The US is costed in the USD sent.</p>
<h3>What it paid for</h3>
<p class="muted small">Enter at least one amount sent: USD, GBP or EUR.</p>
<div class="scroll"><table class="rows" data-need-first><thead><tr><th>Type</th><th>PO / bill / category</th><th>Part</th><th>Invoice amount, USD</th><th>Invoice amount, RMB</th><th>Note</th></tr></thead><tbody>
${allocations.map((a) => html`<tr><td>${select('alloc_type', TYPES, a.type || 'order')}</td>
<td><input name="alloc_target" list="targets" value="${a.target || ''}" data-need="order bill"></td><td>${select('alloc_part', PARTS, a.part || '', { attrs: 'data-need="order"' })}</td>
<td><input name="alloc_usd" inputmode="decimal" value="${a.usd || ''}"></td><td><input name="alloc_rmb" inputmode="decimal" value="${a.rmb || ''}" data-need="order"></td>
<td><input name="alloc_description" value="${a.description || ''}"></td></tr>`)}
</tbody></table></div>
<datalist id="targets">${targets.map((t) => html`<option value="${t}">`)}</datalist>
<p class="muted small"><b>Required on each row you use:</b> for an order, the PO, the part and the RMB the invoice asks for; for a courier bill, the bill. The amount each invoice asks for, not what you sent. When one transfer pays several invoices it’s split by these, so fill in every row: all in USD, or all in RMB if paid straight to RMB. Adding the RMB as well lets an order be confirmed fully paid.</p>
<label><input type="text" name="notes" value="${p?.notes || ''}" placeholder="Notes" style="width:100%"></label>
<p><button>${p?.id ? 'Save payment' : 'Record payment'}</button></p>
</form>
${p?.id ? documentsSection(ctx, 'payment', p.id, { title: 'Receipts', back: `/payments/${enc(p.id)}`, hint: 'e.g. Wise receipt' }) : ''}
${p?.id ? html`<form method="post" action="/payments/${enc(p.id)}/delete" data-confirm="Delete payment ${p.id}? What it paid for will show as unpaid again.">${versionField(p)}<button class="danger">Delete payment</button></form>${history(ctx, 'payment', p.id)}` : ''}`;
  return { title: p?.id || 'New payment', body };
}

export function savePayment(ctx) {
  const { ledger } = ctx.data;
  const existingId = ctx.params[0];
  const existing = existingId ? ledger.payments.find((p) => p.id === existingId) : null;
  if (existingId && !existing) throw notFound(`Payment ${existingId}`);
  if (existing) assertFresh(ctx, 'payment', existingId, existing, `/payments/${enc(existingId)}`);
  let payment;
  try {
    payment = paymentFromForm(ctx, existingId);
  } catch (err) {
    if (err.status !== 400) throw err;
    // Back to the same form, with what was typed and why it wasn't saved.
    const f = ctx.form;
    const values = Object.fromEntries(['date', 'reference', 'usd', 'gbp', 'eur', 'qbRate', 'fee', 'funding', 'notes', 'wise', 'version'].map((k) => [k, f.get(k) ?? '']));
    values.allocations = rows(f, 'alloc', ['type', 'target', 'part', 'usd', 'rmb', 'description'], ['target', 'usd', 'rmb', 'description']);
    return { status: 400, ...paymentForm(ctx, { values, error: err.message }) };
  }
  const allocations = payment.allocations;
  const f = ctx.form;
  const before = computeLandingCosts(ledger);
  saveLedger(ctx.db, { payments: [payment] }, { actor: ctx.actor });
  const wise = text(f, 'wise');
  if (wise) ctx.db.prepare('UPDATE wise_transfers SET payment_id = ? WHERE id = ?').run(payment.id, wise);
  const bills = allocations.filter((a) => a.type === 'bill').map((a) => a.target);
  if (bills.length) queueBillCards(ctx.db, bills, before);
  const firstOrder = allocations.find((a) => a.type === 'order');
  return { redirect: `${firstOrder ? `/orders/${enc(firstOrder.target)}` : '/payments'}?ok=${enc(`Payment ${payment.id} saved.`)}` };
}

/** The payment as typed, checked; throws a 400 HttpError saying what's missing or wrong. */
function paymentFromForm(ctx, existingId) {
  const { ledger } = ctx.data;
  const f = ctx.form;
  const d = date(f.get('date'), 'Date', { required: true });

  const allocations = rows(f, 'alloc', ['type', 'target', 'part', 'usd', 'rmb', 'description'], ['target', 'usd', 'rmb', 'description']).map((a, i) => {
    const where = `Row ${i + 1}`;
    if (!TYPES.some((t) => t.value === a.type)) throw new HttpError(400, `${where}: unknown type`);
    if (a.type === 'order' && !ledger.orders.some((o) => o.po === a.target)) throw new HttpError(400, `${where}: ${a.target || 'blank'} isn't an order on file`);
    if (a.type === 'bill' && !a.target) throw new HttpError(400, `${where}: which courier bill?`);
    if (a.type === 'order' && !a.part) throw new HttpError(400, `${where}: choose the part: Deposit, Balance or Full payment`);
    if (a.type === 'order' && !a.rmb) throw new HttpError(400, `${where}: enter the RMB the invoice asks for, so ${a.target} can be confirmed fully paid`);
    if (a.type === 'bill' && !a.rmb && !a.usd) throw new HttpError(400, `${where}: enter the amount of the bill it pays`);
    return compact({ type: a.type, target: a.target, part: a.part || undefined, usd: number(a.usd, `${where} USD`), rmb: number(a.rmb, `${where} RMB`), description: a.description });
  });
  if (!allocations.length) throw new HttpError(400, 'Say what the payment paid for');
  // One transfer, several invoices: it's split by what each invoice asks for, so
  // every row needs that amount, all in the same currency. Suppliers are paid in
  // USD or RMB, whichever account the transfer was funded from.
  if (allocations.length > 1 && !allocations.every((a) => a.usd) && !allocations.every((a) => a.rmb)) {
    throw new HttpError(400, `This transfer pays ${allocations.length} things, so it’s split between them by what each invoice asks for. Enter that amount on every row: all in USD, or all in RMB if it was paid straight to RMB.`);
  }

  const payment = compact({
    id: existingId || uniqueId(`P-${d}`, new Set(ledger.payments.map((p) => p.id))),
    date: d,
    reference: required(text(f, 'reference'), 'Wise reference'),
    usd: number(f.get('usd'), 'USD'),
    gbp: number(f.get('gbp'), 'GBP'),
    eur: number(f.get('eur'), 'EUR'),
    qbRate: number(f.get('qbRate'), 'QB rate'),
    fee: number(f.get('fee'), 'Wise fee'),
    funding: text(f, 'funding'),
    notes: text(f, 'notes'),
  });
  if (!payment.usd && !payment.gbp && !payment.eur) throw new HttpError(400, 'Enter the amount sent (USD, GBP or EUR)');
  payment.allocations = allocations;
  // UK and DE are costed in GBP: from the USD or EUR balance that needs the QB rate,
  // unless QuickBooks is connected to look it up (until then it shows as pending).
  if (!ctx.qbo && paymentsNeedingRate({ ...ledger, payments: [payment] }).length) {
    throw new HttpError(400, `This pays a UK or DE ${payment.allocations.some((a) => a.type === 'bill') ? 'order or courier bill' : 'order'} from ${payment.eur ? 'EUR' : 'USD'} with no GBP amount, so it needs the QB rate for ${d} (GBP per ${payment.eur ? 'EUR' : 'USD'}), or the GBP it cost.`);
  }
  return payment;
}

export function deletePayment(ctx) {
  const existing = ctx.data.ledger.payments.find((p) => p.id === ctx.params[0]);
  if (existing) assertFresh(ctx, 'payment', existing.id, existing, `/payments/${enc(existing.id)}`);
  if (!deleteRecord(ctx.db, 'payment', ctx.params[0], { actor: ctx.actor })) throw notFound(`Payment ${ctx.params[0]}`);
  return { redirect: '/payments?ok=Payment+deleted.' };
}


function rateStatus(ctx, p) {
  const needs = paymentsNeedingRate(ctx.data.ledger).some((x) => x.id === p.id);
  const lookup = ctx.db.prepare('SELECT * FROM qb_rate_lookups WHERE payment_id = ?').get(p.id);
  if (!needs && !(lookup && lookup.status !== 'found')) return '';
  return html`<div class="notice">This payment needs a QB rate to be costed in GBP.${lookup?.message ? html` ${lookup.message}.` : ''}
${ctx.qbo ? html`<form class="inline" method="post" action="/payments/${enc(p.id)}/qb-rate"><button class="ghost" style="margin-left:8px">Get it from QuickBooks</button></form>` : html` Enter it below (QuickBooks isn’t connected).`}</div>`;
}
