import { html, select, money } from '../html.js';
import { saveLedger, deleteRecord } from '../../landing/store.js';
import { computeLandingCosts } from '../../landing/engine.js';
import { queueBillCards } from '../../notify/bills.js';
import { text, number, date, required, rows, compact, uniqueId } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { enc } from './common.js';
import { history } from './orders.js';
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
  { value: '', label: '' },
  { value: 'deposit', label: 'Deposit' },
  { value: 'balance', label: 'Balance' },
  { value: 'full', label: 'Full payment' },
];
const BLANK_ROWS = 4;

export function paymentsPage(ctx) {
  const { ledger } = ctx.data;
  const body = html`
<h1>Payments</h1>
<p class="sub">Every Wise transfer, its rate, and what it paid for. The PO goes in the Wise reference.</p>
<p><a class="button" href="/payments/new">Record a payment</a> <a href="/wise" style="margin-left:10px">From Wise</a></p>
<div class="card scroll"><table>
<thead><tr><th>Date</th><th>Payment</th><th>Reference</th><th class="n">USD</th><th class="n">GBP / EUR</th><th class="n">QB rate</th><th>Paid for</th></tr></thead>
<tbody>${[...ledger.payments].reverse().map((p) => html`<tr><td>${p.date}</td><td><a href="/payments/${enc(p.id)}">${p.id}</a></td><td>${p.reference || ''}</td>
<td class="n">${money(p.usd, 'USD')}</td><td class="n">${p.gbp ? money(p.gbp, 'GBP') : p.eur ? money(p.eur, 'EUR') : '—'}</td><td class="n">${p.qbRate || '—'}</td>
<td class="small">${(p.allocations || []).map((a, i) => html`${i ? ', ' : ''}${a.type === 'order' ? html`<a href="/orders/${enc(a.target)}">${a.target}</a>` : a.type === 'bill' ? html`<a href="/bills/${enc(a.target)}">${a.target}</a>` : a.target || a.type}${a.part ? ` ${a.part}` : ''}`)}</td></tr>`)}
</tbody></table></div>`;
  return { title: 'Payments', body };
}

export function paymentForm(ctx) {
  const { ledger } = ctx.data;
  const id = ctx.params[0];
  let p = id ? ledger.payments.find((x) => x.id === id) : null;
  if (id && !p) throw notFound(`Payment ${id}`);
  const preset = ctx.url.searchParams.get('po');
  const wiseId = ctx.url.searchParams.get('wise');
  const wise = !p && wiseId ? ctx.db.prepare('SELECT * FROM wise_transfers WHERE id = ?').get(wiseId) : null;
  const fromWise = wise ? paymentFromTransfer(wise) : null;
  if (fromWise) p = { ...fromWise, id: null };
  const allocations = [...(p?.allocations || (fromWise?.allocation ? [fromWise.allocation] : preset ? [{ type: 'order', target: preset }] : []))];
  for (let i = 0; i < BLANK_ROWS; i++) allocations.push({});
  const targets = [
    ...ledger.orders.map((o) => o.po),
    ...ledger.courierBills.map((b) => b.id),
  ];

  const body = html`
<p class="muted small"><a href="/payments">Payments</a></p>
<h1>${p?.id ? `Payment ${p.id}` : 'Record a payment'}</h1>
${fromWise ? html`<p class="notice">Filled in from the Wise transfer of ${fromWise.date}${fromWise.reference ? ` (“${fromWise.reference}”)` : ''}. Check the amounts against Wise and say what it paid for.</p>` : ''}
${p?.id ? rateStatus(ctx, p) : ''}
<form class="card" method="post" action="/payments${p?.id ? `/${enc(p.id)}` : ''}">
${fromWise ? html`<input type="hidden" name="wise" value="${fromWise.wise}">` : ''}
<div class="grid">
  <div><label>Date (required)</label><input type="date" name="date" value="${p?.date || ''}" required></div>
  <div><label>Wise reference</label><input name="reference" value="${p?.reference || ''}" placeholder="PO-020 30%"></div>
  <div><label>USD sent</label><input name="usd" inputmode="decimal" value="${p?.usd || ''}"></div>
  <div><label>GBP actually paid</label><input name="gbp" inputmode="decimal" value="${p?.gbp || ''}"></div>
  <div><label>EUR sent</label><input name="eur" inputmode="decimal" value="${p?.eur || ''}"></div>
  <div><label>QB rate (GBP per USD or EUR)</label><input name="qbRate" inputmode="decimal" value="${p?.qbRate || ''}"></div>
  <div><label>Wise fee (expense)</label><input name="fee" inputmode="decimal" value="${p?.fee || ''}"></div>
  <div><label>Funded from</label><input name="funding" value="${p?.funding || ''}" placeholder="USD balance / GBP / EUR"></div>
</div>
<p class="muted small">UK and DE are costed in GBP: the GBP actually paid if you paid in GBP, otherwise USD or EUR × the QB rate on this date. The US is costed in the USD sent.</p>
<h3>What it paid for</h3>
<div class="scroll"><table class="rows"><thead><tr><th>Type</th><th>PO / bill / category</th><th>Part</th><th>USD on the invoice</th><th>RMB on the invoice</th><th>Note</th></tr></thead><tbody>
${allocations.map((a) => html`<tr><td>${select('alloc_type', TYPES, a.type || 'order')}</td>
<td><input name="alloc_target" list="targets" value="${a.target || ''}"></td><td>${select('alloc_part', PARTS, a.part || '')}</td>
<td><input name="alloc_usd" inputmode="decimal" value="${a.usd || ''}"></td><td><input name="alloc_rmb" inputmode="decimal" value="${a.rmb || ''}"></td>
<td><input name="alloc_description" value="${a.description || ''}"></td></tr>`)}
</tbody></table></div>
<datalist id="targets">${targets.map((t) => html`<option value="${t}">`)}</datalist>
<p class="muted small">When one transfer pays several invoices, give each its USD so the transfer can be split. Never link on amount alone.</p>
<label><input type="text" name="notes" value="${p?.notes || ''}" placeholder="Notes" style="width:100%"></label>
<p><button>${p?.id ? 'Save payment' : 'Record payment'}</button></p>
</form>
${p?.id ? html`<form method="post" action="/payments/${enc(p.id)}/delete"><button class="danger">Delete payment</button></form>${history(ctx, 'payment', p.id)}` : ''}`;
  return { title: p?.id || 'New payment', body };
}

export function savePayment(ctx) {
  const { ledger } = ctx.data;
  const existingId = ctx.params[0];
  if (existingId && !ledger.payments.some((p) => p.id === existingId)) throw notFound(`Payment ${existingId}`);
  const f = ctx.form;
  const d = date(f.get('date'), 'Date', { required: true });

  const allocations = rows(f, 'alloc', ['type', 'target', 'part', 'usd', 'rmb', 'description'], ['target', 'usd', 'rmb', 'description']).map((a, i) => {
    const where = `Row ${i + 1}`;
    if (!TYPES.some((t) => t.value === a.type)) throw new HttpError(400, `${where}: unknown type`);
    if (a.type === 'order' && !ledger.orders.some((o) => o.po === a.target)) throw new HttpError(400, `${where}: ${a.target || 'blank'} isn't an order on file`);
    if (a.type === 'bill' && !a.target) throw new HttpError(400, `${where}: which courier bill?`);
    return compact({ type: a.type, target: a.target, part: a.part || undefined, usd: number(a.usd, `${where} USD`), rmb: number(a.rmb, `${where} RMB`), description: a.description });
  });
  if (!allocations.length) throw new HttpError(400, 'Say what the payment paid for');

  const payment = compact({
    id: existingId || uniqueId(`P-${d}`, new Set(ledger.payments.map((p) => p.id))),
    date: d,
    reference: text(f, 'reference'),
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
  const before = computeLandingCosts(ledger);
  saveLedger(ctx.db, { payments: [payment] }, { actor: ctx.actor });
  const wise = text(f, 'wise');
  if (wise) ctx.db.prepare('UPDATE wise_transfers SET payment_id = ? WHERE id = ?').run(payment.id, wise);
  const bills = allocations.filter((a) => a.type === 'bill').map((a) => a.target);
  if (bills.length) queueBillCards(ctx.db, bills, before);
  const firstOrder = allocations.find((a) => a.type === 'order');
  return { redirect: `${firstOrder ? `/orders/${enc(firstOrder.target)}` : '/payments'}?ok=${enc(`Payment ${payment.id} saved.`)}` };
}

export function deletePayment(ctx) {
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
