import { html, units, unitCost, badge, BATCH_STATUS, shipmentStatusLabel } from '../html.js';
import { notFound } from '../errors.js';
import { productName, enc } from './common.js';
import { working } from './orders.js';

export function costsPage(ctx) {
  const { ledger, result } = ctx.data;
  const batches = [...result.batches].reverse();
  const body = html`
<h1>Landing costs by batch</h1>
<p class="sub">One row per product per shipment — what Sellerboard receives. GBP for the UK and DE, USD for the US.</p>
<div class="card scroll"><table>
<thead><tr><th>Product</th><th>Mkt</th><th>Shipment</th><th class="n">Units</th><th class="n">Product</th><th class="n">Delivery</th><th class="n">Landing</th><th>Status</th></tr></thead>
<tbody>${batches.map((b) => html`<tr><td><a href="/costs/${enc(b.shipment)}/${enc(b.product)}">${productName(ledger, b.product)}</a></td><td>${b.marketplace}</td>
<td><a href="/shipments/${enc(b.shipment)}">${b.shipment}</a></td><td class="n">${units(b.units)}</td><td class="n">${unitCost(b.productCost, b.currency)}</td>
<td class="n">${unitCost(b.deliveryCost, b.currency)}${b.deliveryBasis === 'estimated' ? html` <span class="muted small">est.</span>` : ''}</td>
<td class="n"><b>${unitCost(b.landingCost, b.currency)}</b></td><td>${badge(BATCH_STATUS[b.status])}</td></tr>`)}
</tbody></table></div>
<p class="muted small">Final: paid, closed and billed. Awaiting Amazon count: costs known, unit count not final. Estimated: delivery borrowed from an earlier shipment. Deposit only: balance not paid yet, cost projected.</p>`;
  return { title: 'Costs', body };
}

export function batchPage(ctx) {
  const { ledger, result } = ctx.data;
  const [shipment, product] = ctx.params;
  const b = result.batches.find((x) => x.shipment === shipment && x.product === product);
  if (!b) throw notFound(`Batch ${product} in ${shipment}`);
  const body = html`
<p class="muted small"><a href="/costs">Costs</a></p>
<h1>${productName(ledger, b.product)} · ${b.shipment}</h1>
<p>${badge(BATCH_STATUS[b.status])} · Amazon: ${shipmentStatusLabel(b.shipmentStatus)} · ${units(b.units)} units ${b.received !== null ? 'received' : 'shipped'}
${b.batchDate ? html` · Sellerboard batch date ${b.batchDate}` : ''} · from ${b.orders.map((po, i) => html`${i ? ', ' : ''}<a href="/orders/${enc(po)}">${po}</a>`)}</p>
<div class="card">${working(b)}</div>`;
  return { title: `${b.product} · ${b.shipment}`, body };
}
