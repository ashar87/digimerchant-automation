import { html, select, rmb, money, unitCost } from '../html.js';
import { saveLedger, deleteRecord } from '../../landing/store.js';
import { computeLandingCosts } from '../../landing/engine.js';
import { queueBillCards } from '../../notify/bills.js';
import { text, number, date, required, rows, compact, uniqueId } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { enc } from './common.js';
import { history } from './orders.js';
import { versionField, assertFresh } from '../versions.js';

const KINDS = [
  { value: 'shipping', label: 'Shipping' },
  { value: 'domestic', label: 'Domestic shipping' },
  { value: 'fee', label: 'Fee (shared)' },
  { value: 'adjustment', label: 'Adjustment (rate diff, credit)' },
  { value: 'expense', label: 'Expense (not landing cost)' },
];
const BLANK_LINES = 6;

export function billsPage(ctx) {
  const { ledger } = ctx.data;
  const body = html`
<h1>Courier bills</h1>
<p class="sub">Each line names its FBA shipment, so a bill covering many orders attaches line by line.</p>
<p><a class="button" href="/bills/new">Add a courier bill</a></p>
<div class="card scroll"><table><thead><tr><th>Date</th><th>Bill</th><th>Agent</th><th>Shipments</th><th class="n">RMB</th></tr></thead><tbody>
${[...ledger.courierBills].reverse().map((b) => html`<tr><td>${b.date || ''}</td><td><a href="/bills/${enc(b.id)}">${b.id}</a></td><td>${b.agent || ''}</td>
<td class="small">${[...new Set(b.lines.map((l) => l.shipment).filter(Boolean))].join(', ')}</td><td class="n">${rmb(b.lines.reduce((a, l) => a + Number(l.rmb || 0), 0))}</td></tr>`)}
</tbody></table></div>`;
  return { title: 'Courier bills', body };
}

export function billPage(ctx) {
  const { ledger, result } = ctx.data;
  const id = ctx.params[0];
  const bill = id ? ledger.courierBills.find((b) => b.id === id) : null;
  if (id && !bill) throw notFound(`Courier bill ${id}`);
  const allocations = bill ? result.shipments.flatMap((s) => s.delivery.bills.filter((b) => b.bill === bill.id).map((b) => ({ shipment: s, ...b }))) : [];
  const paidBy = bill ? ledger.payments.filter((p) => p.allocations.some((a) => a.type === 'bill' && a.target === bill.id)) : [];
  const issues = bill ? result.issues.filter((i) => i.ref === bill.id && i.severity !== 'info') : [];
  const lines = [...(bill?.lines || [])];
  for (let i = 0; i < BLANK_LINES; i++) lines.push({});

  const body = html`
<p class="muted small"><a href="/bills">Courier bills</a></p>
<h1>${bill ? bill.id : 'Add a courier bill'}</h1>
${bill
  ? html`<p>${bill.agent || ''} ${bill.date || ''} · paid by ${paidBy.length ? paidBy.map((p, i) => html`${i ? ', ' : ''}<a href="/payments/${enc(p.id)}">${p.id}</a>`) : html`no payment yet — <a href="/payments/new">record it</a> with a “Courier bill” row for ${bill.id}`}</p>
${issues.map((i) => html`<p class="notice">${i.message}</p>`)}
${allocations.length
  ? html`<h2>Allocated to shipments</h2><div class="card scroll"><table><thead><tr><th>Shipment</th><th class="n">Share</th><th class="n">Delivery cost</th><th class="n">Per unit</th></tr></thead><tbody>
${allocations.map((a) => html`<tr><td><a href="/shipments/${enc(a.shipment.id)}">${a.shipment.id}</a> ${a.shipment.marketplace}</td><td class="n">${a.share ? `${a.share.times(100).toFixed(2)}%` : '—'}</td><td class="n">${money(a.amount, a.shipment.currency)}</td><td class="n">${unitCost(a.shipment.delivery.perUnit, a.shipment.currency)}</td></tr>`)}
</tbody></table></div>`
  : ''}`
  : ''}
<h2>${bill ? 'Edit' : 'Lines'}</h2>
<form class="card" method="post" action="/bills${bill ? `/${enc(bill.id)}` : ''}">
${bill ? versionField(bill) : ''}
<div class="grid">
  <div><label>Agent</label><input name="agent" value="${bill?.agent || 'Annie'}"></div>
  <div><label>Date</label><input type="date" name="date" value="${bill?.date || ''}" required></div>
  <div><label>Total on the bill (RMB)</label><input name="statedTotalRmb" inputmode="decimal" value="${bill?.statedTotalRmb || ''}"></div>
  <div><label>Rate on the bill (RMB per USD)</label><input name="rmbPerUsd" inputmode="decimal" value="${bill?.rmbPerUsd || ''}"></div>
</div>
<div class="scroll"><table class="rows"><thead><tr><th>Kind</th><th>FBA shipment</th><th>RMB</th><th>Description</th></tr></thead><tbody>
${lines.map((l) => html`<tr><td>${select('line_kind', KINDS, l.kind || 'shipping')}</td><td><input name="line_shipment" list="shipments" value="${l.shipment || ''}"></td>
<td><input name="line_rmb" inputmode="decimal" value="${l.rmb || ''}"></td><td><input name="line_description" value="${l.description || l.category || ''}"></td></tr>`)}
</tbody></table></div>
<datalist id="shipments">${ledger.shipments.map((s) => html`<option value="${s.id}">`)}</datalist>
<p class="muted small">Put domestic shipping on its own shipment’s line. Fees and adjustments with no shipment are shared by RMB share. The bill’s total and rate are checked against its lines.</p>
<button>${bill ? 'Save bill' : 'Add bill'}</button></form>
${bill ? html`<form method="post" action="/bills/${enc(bill.id)}/delete">${versionField(bill)}<button class="danger">Delete bill</button></form>${history(ctx, 'courier_bill', bill.id)}` : ''}`;
  return { title: bill ? bill.id : 'New courier bill', body };
}

export function saveBill(ctx) {
  const { ledger } = ctx.data;
  const existingId = ctx.params[0];
  const existing = existingId ? ledger.courierBills.find((b) => b.id === existingId) : null;
  if (existingId && !existing) throw notFound(`Courier bill ${existingId}`);
  if (existing) assertFresh(ctx, 'courier_bill', existingId, existing, `/bills/${enc(existingId)}`);
  const f = ctx.form;
  const d = date(f.get('date'), 'Date', { required: true });
  const agent = text(f, 'agent');

  const lines = rows(f, 'line', ['kind', 'shipment', 'rmb', 'description'], ['shipment', 'rmb', 'description']).map((l, i) => {
    const where = `Line ${i + 1}`;
    if (!KINDS.some((k) => k.value === l.kind)) throw new HttpError(400, `${where}: unknown kind`);
    const shipment = l.shipment ? l.shipment.toUpperCase() : undefined;
    if (l.kind === 'shipping' && !shipment) throw new HttpError(400, `${where}: shipping needs its FBA shipment`);
    const line = compact({ kind: l.kind, shipment, rmb: number(l.rmb, `${where} RMB`) });
    if (l.description) line[l.kind === 'expense' ? 'category' : 'description'] = l.description;
    return line;
  });
  if (!lines.length) throw new HttpError(400, 'A bill needs at least one line');
  if (lines.length > 1 && lines.some((l) => l.rmb === undefined)) throw new HttpError(400, 'Every line needs its RMB amount (only a one-line bill may give USD alone)');

  const id = existingId || uniqueId(`${(agent || 'BILL').toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${d}`, new Set(ledger.courierBills.map((b) => b.id)));
  const bill = compact({ id, agent, date: d, statedTotalRmb: number(f.get('statedTotalRmb'), 'Bill total'), rmbPerUsd: number(f.get('rmbPerUsd'), 'Rate') });
  bill.lines = lines;

  const before = computeLandingCosts(ledger);
  saveLedger(ctx.db, { courierBills: [bill] }, { actor: ctx.actor });
  queueBillCards(ctx.db, [bill.id], before);
  return { redirect: `/bills/${enc(id)}?ok=${enc(`${id} saved.`)}` };
}

export function deleteBill(ctx) {
  const existing = ctx.data.ledger.courierBills.find((b) => b.id === ctx.params[0]);
  if (existing) assertFresh(ctx, 'courier_bill', existing.id, existing, `/bills/${enc(existing.id)}`);
  if (!deleteRecord(ctx.db, 'courier_bill', ctx.params[0], { actor: ctx.actor })) throw notFound(`Courier bill ${ctx.params[0]}`);
  return { redirect: '/bills?ok=Bill+deleted.' };
}
