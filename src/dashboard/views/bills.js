import { html, rmb, money } from '../html.js';
import { notFound } from '../errors.js';
import { enc } from './common.js';

export function billsPage(ctx) {
  const { ledger } = ctx.data;
  const body = html`
<h1>Courier bills</h1>
<p class="sub">Each line names its FBA shipment, so a bill covering many orders attaches line by line.</p>
<div class="card scroll"><table><thead><tr><th>Date</th><th>Bill</th><th>Agent</th><th>Shipments</th><th class="n">RMB</th></tr></thead><tbody>
${[...ledger.courierBills].reverse().map((b) => html`<tr><td>${b.date || ''}</td><td><a href="/bills/${enc(b.id)}">${b.id}</a></td><td>${b.agent || ''}</td>
<td class="small">${[...new Set(b.lines.map((l) => l.shipment).filter(Boolean))].join(', ')}</td><td class="n">${rmb(b.lines.reduce((a, l) => a + Number(l.rmb || 0), 0))}</td></tr>`)}
</tbody></table></div>`;
  return { title: 'Courier bills', body };
}

export function billPage(ctx) {
  const { ledger, result } = ctx.data;
  const bill = ledger.courierBills.find((b) => b.id === ctx.params[0]);
  if (!bill) throw notFound(`Courier bill ${ctx.params[0]}`);
  const allocations = result.shipments.flatMap((s) => s.delivery.bills.filter((b) => b.bill === bill.id).map((b) => ({ shipment: s, ...b })));
  const paidBy = ledger.payments.filter((p) => p.allocations.some((a) => a.type === 'bill' && a.target === bill.id));
  const issues = result.issues.filter((i) => i.ref === bill.id && i.severity !== 'info');
  const body = html`
<p class="muted small"><a href="/bills">Courier bills</a></p>
<h1>${bill.id}</h1>
<p>${bill.agent || ''} ${bill.date || ''} ${bill.rmbPerUsd ? html`· rate ${bill.rmbPerUsd} RMB/USD` : ''} · paid by ${paidBy.length ? paidBy.map((p, i) => html`${i ? ', ' : ''}<a href="/payments/${enc(p.id)}">${p.id}</a>`) : 'no payment yet'}</p>
${issues.map((i) => html`<p class="notice">${i.message}</p>`)}
<h2>Lines</h2>
<div class="card scroll"><table><thead><tr><th>Kind</th><th>Shipment</th><th class="n">RMB</th><th>Description</th></tr></thead><tbody>
${bill.lines.map((l) => html`<tr><td>${l.kind}</td><td>${l.shipment ? html`<a href="/shipments/${enc(l.shipment)}">${l.shipment}</a>` : html`<span class="muted">shared</span>`}</td><td class="n">${rmb(l.rmb)}</td><td class="small">${l.description || l.category || ''}</td></tr>`)}
</tbody></table></div>
<h2>Allocated to shipments</h2>
<div class="card scroll"><table><thead><tr><th>Shipment</th><th class="n">Share</th><th class="n">Delivery cost</th></tr></thead><tbody>
${allocations.map((a) => html`<tr><td><a href="/shipments/${enc(a.shipment.id)}">${a.shipment.id}</a> ${a.shipment.marketplace}</td><td class="n">${a.share ? `${a.share.times(100).toFixed(2)}%` : '—'}</td><td class="n">${money(a.amount, a.shipment.currency)}</td></tr>`)}
</tbody></table></div>`;
  return { title: bill.id, body };
}
