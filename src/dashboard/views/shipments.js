import { html, select, units, unitCost, badge, BATCH_STATUS, SHIPMENT_STATUSES, shipmentStatusLabel } from '../html.js';
import { saveLedger, deleteRecord } from '../../landing/store.js';
import { text, number, date, required, rows, compact } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { MARKETPLACES, productOptions, poOptions, productName, enc } from './common.js';
import { history } from './orders.js';
import { amazonPanel } from './amazon.js';

const BLANK_ITEMS = 3;

export function shipmentsPage(ctx) {
  const { ledger, result } = ctx.data;
  const results = new Map(result.shipments.map((s) => [s.id, s]));
  const body = html`
<h1>Shipments</h1>
<p class="sub">Status and counts come from Amazon each morning once it’s connected; until then they’re entered here.</p>
${amazonPanel(ctx)}
<p><a class="button" href="/shipments/new">Add a shipment</a></p>
<div class="card scroll"><table>
<thead><tr><th>Shipment</th><th>Mkt</th><th>Contents</th><th>Amazon</th><th class="n">Received</th><th>Order</th><th class="n">Delivery / unit</th></tr></thead>
<tbody>${[...ledger.shipments].reverse().map((s) => {
  const r = results.get(s.id);
  const diff = r.closed ? r.receivedUnits.minus(r.shippedUnits) : null;
  const pos = [...new Set(s.items.map((i) => i.po).filter(Boolean))];
  return html`<tr><td><a href="/shipments/${enc(s.id)}">${s.id}</a></td><td>${s.marketplace}</td>
  <td class="small">${s.items.map((i, n) => html`${n ? ', ' : ''}${productName(ledger, i.product)} ×${units(i.shipped)}`)}</td>
  <td>${shipmentStatusLabel(s.status)}</td>
  <td class="n">${r.closed ? html`${units(r.receivedUnits)} ${diff.isZero() ? '' : html`<span class="${diff.lt(0) ? 'bad' : 'ok'} badge">${diff.gt(0) ? '+' : ''}${diff.toString()}</span>`}` : html`— / ${units(r.shippedUnits)}`}</td>
  <td class="small">${pos.length ? pos.map((po, n) => html`${n ? ', ' : ''}<a href="/orders/${enc(po)}">${po}</a>`) : badge(['Not linked', 'bad'])}${s.items.some((i) => !i.po) && pos.length ? ' +unlinked' : ''}</td>
  <td class="n">${unitCost(r.delivery.perUnit, r.currency)} ${r.delivery.basis === 'estimated' ? html`<span class="muted small">est.</span>` : ''}</td></tr>`;
})}</tbody></table></div>`;
  return { title: 'Shipments', body };
}

export function shipmentForm(ctx) {
  const { ledger, result } = ctx.data;
  const id = ctx.params[0];
  const s = id ? ledger.shipments.find((x) => x.id === id) : null;
  if (id && !s) throw notFound(`Shipment ${id}`);
  const r = s ? result.shipments.find((x) => x.id === s.id) : null;
  const batches = s ? result.batches.filter((b) => b.shipment === s.id) : [];
  const items = [...(s?.items || [])];
  for (let i = 0; i < BLANK_ITEMS; i++) items.push({});
  const marketplace = s?.marketplace;

  const body = html`
<p class="muted small"><a href="/shipments">Shipments</a></p>
<h1>${s ? `${s.id} · ${s.marketplace}` : 'Add a shipment'}</h1>
${s ? html`<p>${shipmentStatusLabel(s.status)}${s.name ? html` · “${s.name}”` : ''}</p>` : ''}
${batches.length
  ? html`<div class="card scroll"><table><thead><tr><th>Product</th><th class="n">Units</th><th class="n">Product</th><th class="n">Delivery</th><th class="n">Landing</th><th>Status</th></tr></thead><tbody>${batches.map(
      (b) => html`<tr><td><a href="/costs/${enc(b.shipment)}/${enc(b.product)}">${productName(ledger, b.product)}</a></td><td class="n">${units(b.units)}</td><td class="n">${unitCost(b.productCost, b.currency)}</td>
      <td class="n">${unitCost(b.deliveryCost, b.currency)}${b.deliveryBasis === 'estimated' ? '*' : ''}</td><td class="n">${unitCost(b.landingCost, b.currency)}</td><td>${badge(BATCH_STATUS[b.status])}</td></tr>`
    )}</tbody></table>
    ${r.delivery.basis === 'estimated' ? html`<p class="muted small">* Estimated from ${r.delivery.estimatedFrom} until the courier bill arrives.</p>` : ''}</div>`
  : ''}

<form class="card" method="post" action="/shipments${s ? `/${enc(s.id)}` : ''}">
<div class="grid">
  <div><label>FBA shipment ID</label><input name="id" value="${s?.id || ''}" ${s ? 'readonly' : 'required'} pattern="FBA[A-Z0-9]+"></div>
  <div><label>Marketplace</label>${select('marketplace', MARKETPLACES, marketplace || 'UK')}</div>
  <div><label>Name in Send to Amazon</label><input name="name" value="${s?.name || ''}" placeholder="PO-020 UK"></div>
  <div><label>Amazon status</label>${select('status', SHIPMENT_STATUSES.map((x) => ({ value: x, label: shipmentStatusLabel(x) })), s?.status, { blank: true })}</div>
  <div><label>Created</label><input type="date" name="createdAt" value="${s?.createdAt || ''}"></div>
  <div><label>Amazon started receiving</label><input type="date" name="firstReceivedAt" value="${s?.firstReceivedAt || ''}"></div>
</div>
<h3>Contents — link each line to its order</h3>
<div class="scroll"><table class="rows"><thead><tr><th>Product</th><th>Order</th><th>Units shipped</th><th>Units received</th></tr></thead><tbody>
${items.map((i) => html`<tr><td>${select('item_product', productOptions(ledger, marketplace), i.product, { blank: true })}</td>
<td>${select('item_po', poOptions(ledger, marketplace), i.po, { blank: true })}</td>
<td><input name="item_shipped" inputmode="decimal" value="${i.shipped || ''}"></td><td><input name="item_received" inputmode="decimal" value="${i.received || ''}"></td></tr>`)}
</tbody></table></div>
<p class="muted small">Received counts only count once the shipment is Closed. Until then, costs use units shipped and ordered.</p>
<p><label style="display:inline;color:inherit"><input type="checkbox" name="sellerboardManual" value="1"${s?.sellerboardManual ? ' checked' : ''}> Its cost was typed into Sellerboard by hand — keep it out of the feed</label></p>
<button>${s ? 'Save shipment' : 'Add shipment'}</button></form>
${s ? html`<form method="post" action="/shipments/${enc(s.id)}/delete"><button class="danger">Delete shipment</button></form>${history(ctx, 'shipment', s.id)}` : ''}`;
  return { title: s ? s.id : 'New shipment', body };
}

export function saveShipment(ctx) {
  const { ledger } = ctx.data;
  const f = ctx.form;
  const existingId = ctx.params[0];
  const existing = existingId ? ledger.shipments.find((x) => x.id === existingId) : null;
  if (existingId && !existing) throw notFound(`Shipment ${existingId}`);
  const id = existingId || required(text(f, 'id'), 'FBA shipment ID').toUpperCase();
  if (!existingId && !/^FBA[A-Z0-9]+$/.test(id)) throw new HttpError(400, 'FBA shipment IDs look like FBA15ABC1234');
  if (!existingId && ledger.shipments.some((x) => x.id === id)) throw new HttpError(400, `${id} already exists`);
  const marketplace = text(f, 'marketplace');
  if (!MARKETPLACES.includes(marketplace)) throw new HttpError(400, 'Choose UK, DE or US');
  const status = text(f, 'status');

  const items = rows(f, 'item', ['product', 'po', 'shipped', 'received'], ['product', 'shipped', 'received']).map((i, n) => {
    const where = `Line ${n + 1}`;
    const product = ledger.products.find((p) => p.id === i.product);
    if (!product) throw new HttpError(400, `${where}: choose a product`);
    if (product.marketplace !== marketplace) throw new HttpError(400, `${where}: ${product.id} is a ${product.marketplace} product`);
    const order = i.po ? ledger.orders.find((o) => o.po === i.po) : null;
    if (i.po && !order) throw new HttpError(400, `${where}: unknown order ${i.po}`);
    if (order && order.marketplace !== marketplace) throw new HttpError(400, `${where}: ${order.po} is a ${order.marketplace} order`);
    return compact({ product: i.product, po: i.po || undefined, shipped: required(number(i.shipped, `${where} units shipped`), `${where} units shipped`), received: number(i.received, `${where} units received`) });
  });

  const shipment = compact({
    ...existing,
    id,
    marketplace,
    name: text(f, 'name'),
    status,
    createdAt: date(f.get('createdAt'), 'Created'),
    firstReceivedAt: date(f.get('firstReceivedAt'), 'Receiving date'),
  });
  if (!text(f, 'name')) delete shipment.name;
  if (f.get('sellerboardManual')) shipment.sellerboardManual = true;
  else delete shipment.sellerboardManual;
  if (!status) delete shipment.status;
  shipment.items = items;
  saveLedger(ctx.db, { shipments: [shipment] }, { actor: ctx.actor });
  return { redirect: `/shipments/${enc(id)}?ok=${enc(`${id} saved.`)}` };
}

export function deleteShipment(ctx) {
  if (!deleteRecord(ctx.db, 'shipment', ctx.params[0], { actor: ctx.actor })) throw notFound(`Shipment ${ctx.params[0]}`);
  return { redirect: '/shipments?ok=Shipment+deleted.' };
}
