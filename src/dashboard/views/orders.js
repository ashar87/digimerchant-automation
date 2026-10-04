import { html, raw, select, badge, rmb, units, pct, unitCost, money, BATCH_STATUS, PAID_STATUS, shipmentStatusLabel } from '../html.js';
import { saveLedger, nextPo, auditTrail } from '../../landing/store.js';
import { text, number, date, required, rows, compact, uniqueId } from '../forms.js';
import { HttpError } from '../errors.js';
import { MARKETPLACES, productOptions, findOrder, productName, enc } from './common.js';
import { versionField, assertFresh } from '../versions.js';

const LINE_KINDS = [
  { value: 'goods', label: 'Goods' },
  { value: 'labour', label: 'Labour' },
  { value: 'fee', label: 'Fee (e.g. Annie 1%)' },
  { value: 'adjustment', label: 'Adjustment (rate diff, re-price)' },
  { value: 'expense', label: 'Expense (not landing cost)' },
];
const BLANK_LINES = 6;

/* ---------------------------- list ---------------------------- */

export function ordersPage(ctx) {
  const { ledger, result } = ctx.data;
  const byPo = new Map(result.orders.map((o) => [o.po, o]));
  const body = html`
<h1>Orders</h1>
<p class="sub">One page per order, in place of a 30% tab and a 70% tab that have to find each other.</p>
<div class="card scroll"><table>
<thead><tr><th>PO</th><th>Supplier</th><th>Mkt</th><th>Products</th><th>Invoice</th><th class="n">RMB</th><th>Paid</th><th></th></tr></thead>
<tbody>${[...ledger.orders].reverse().map((o) => {
  const r = byPo.get(o.po);
  return html`<tr><td><a href="/orders/${enc(o.po)}">${o.po}</a></td><td>${o.supplier}</td><td>${o.marketplace}</td>
  <td class="small">${r.lines.map((l, i) => html`${i ? ', ' : ''}${productName(ledger, l.product)} ×${units(l.ordered)}`)}</td>
  <td class="small">${r.invoice ? `${r.invoice.kind} ${r.invoice.date || ''}` : '—'}</td><td class="n">${rmb(r.totalRmb)}</td>
  <td>${badge(PAID_STATUS[r.paidStatus])}</td><td>${o.review === 'needs_review' ? badge(['To check', 'warn']) : ''}</td></tr>`;
})}</tbody></table></div>

<h2>New order</h2>
<form class="card" method="post" action="/orders">
<div class="grid">
  <div><label>PO number (required)</label><input name="po" value="${nextPo(ctx.db)}" required pattern="PO-\\d+"></div>
  <div><label>Supplier</label><input name="supplier" required></div>
  <div><label>Marketplace</label>${select('marketplace', MARKETPLACES, 'UK')}</div>
  <div><label>Notes</label><input name="notes"></div>
</div>
<button>Create order</button> <span class="muted small">Then add its proforma or invoice. Use the PO in the Wise reference (e.g. “${nextPo(ctx.db)} 30%”) and in the FBA shipment name.</span>
</form>`;
  return { title: 'Orders', body };
}

export function createOrder(ctx) {
  const f = ctx.form;
  const po = required(text(f, 'po'), 'PO number');
  if (!/^PO-\d+$/.test(po)) throw new HttpError(400, 'PO numbers look like PO-020');
  if (ctx.data.ledger.orders.some((o) => o.po === po)) throw new HttpError(400, `${po} already exists`);
  const marketplace = text(f, 'marketplace');
  if (!MARKETPLACES.includes(marketplace)) throw new HttpError(400, 'Choose UK, DE or US');
  saveLedger(ctx.db, { orders: [compact({ po, supplier: required(text(f, 'supplier'), 'Supplier'), marketplace, notes: text(f, 'notes'), invoices: [] })] }, { actor: ctx.actor });
  return { redirect: `/orders/${enc(po)}?ok=${enc(`${po} created. Add its invoice below.`)}` };
}

/* ---------------------------- one order ---------------------------- */

export function orderPage(ctx) {
  const { ledger, result } = ctx.data;
  const order = findOrder(ctx, ctx.params[0]);
  const r = result.orders.find((o) => o.po === order.po);
  const cur = r.currency;
  const batches = result.batches.filter((b) => b.orders.includes(order.po));
  const shipments = ledger.shipments.filter((s) => s.items.some((i) => i.po === order.po));
  const shipmentResults = new Map(result.shipments.map((s) => [s.id, s]));

  const body = html`
<p class="muted small"><a href="/orders">Orders</a></p>
<h1>${order.po} · ${order.supplier} · ${order.marketplace}</h1>
<p>${badge(PAID_STATUS[r.paidStatus])}
${order.review === 'needs_review'
  ? html` ${badge(['Imported, to check', 'warn'])} <form class="inline" method="post" action="/orders/${enc(order.po)}/review">${versionField(order)}<button class="ghost">Mark checked</button></form>`
  : ''}</p>
${order.notes ? html`<p class="sub">${order.notes}</p>` : ''}
${order.importNotes?.length
  ? html`<div class="notice"><b>Imported from ${order.source || 'the sheet'}.</b> Check against the sheet before marking it checked.<ul>${order.importNotes.map((n) => html`<li>${n}</li>`)}</ul></div>`
  : ''}

<h2>Products${r.invoice ? html` <span class="muted small">· ${r.invoice.kind} invoice ${r.invoice.date || ''} · ${rmb(r.totalRmb)} RMB</span>` : ''}</h2>
<div class="card scroll"><table>
<thead><tr><th>Product</th><th class="n">Units</th><th class="n">RMB share</th><th class="n">Line cost</th><th class="n">Product / unit</th><th>Divided by</th><th class="n">Landing / unit</th></tr></thead>
<tbody>${r.lines.map((l) => {
  const landings = batches.filter((b) => b.product === l.product && b.landingCost !== null);
  return html`<tr><td>${productName(ledger, l.product)}</td><td class="n">${units(l.ordered)}</td><td class="n">${pct(l.fraction)}</td>
  <td class="n">${money(l.cost, cur)}${l.projected ? '*' : ''}</td><td class="n">${unitCost(l.unitCost, cur)}</td>
  <td class="small">${units(l.divisor)} ${l.basis}</td>
  <td class="n">${landings.length ? landings.map((b, i) => html`${i ? raw('<br>') : ''}${unitCost(b.landingCost, cur)} <span class="muted small">${b.shipment}</span>`) : '—'}</td></tr>`;
})}</tbody></table>
${r.lines.some((l) => l.projected) ? html`<p class="muted small">* Only the deposit is paid, so the full cost is projected at the deposit’s rate.</p>` : ''}
</div>

<h2>Payments ${r.paidStatus === 'paid' ? html`<span class="muted small">· fully paid</span>` : ''}</h2>
<div class="card scroll"><table>
<thead><tr><th>Date</th><th>Payment</th><th>Reference</th><th>Part</th><th class="n">${cur}</th><th class="n">RMB</th></tr></thead>
<tbody>${r.payments.map((p) => html`<tr><td>${p.date}</td><td><a href="/payments/${enc(p.payment)}">${p.payment}</a></td><td>${p.reference || ''}</td><td>${p.part || ''}</td><td class="n">${money(p.amount, cur)}</td><td class="n">${rmb(p.rmb)}</td></tr>`)}
<tr class="total"><td colspan="4">Total</td><td class="n">${money(r.cash, cur)}</td><td class="n">${rmb(r.paidRmb)}</td></tr></tbody></table>
<p><a class="button" href="/payments/new?po=${enc(order.po)}">Record a payment</a></p></div>

<h2>Shipments from this order</h2>
${shipments.length
  ? html`<div class="card scroll"><table><thead><tr><th>Shipment</th><th>Amazon</th><th class="n">Shipped</th><th class="n">Received</th><th class="n">Delivery / unit</th></tr></thead><tbody>${shipments.map((s) => {
      const sr = shipmentResults.get(s.id);
      const mine = s.items.filter((i) => i.po === order.po);
      return html`<tr><td><a href="/shipments/${enc(s.id)}">${s.id}</a></td><td>${shipmentStatusLabel(s.status)}</td>
      <td class="n">${units(mine.reduce((a, i) => a + Number(i.shipped || 0), 0))}</td><td class="n">${sr?.closed ? units(mine.reduce((a, i) => a + Number(i.received || 0), 0)) : '—'}</td>
      <td class="n">${unitCost(sr?.delivery.perUnit, cur)} <span class="muted small">${sr?.delivery.basis === 'estimated' ? 'est.' : sr?.delivery.bills.map((b) => b.bill).join(', ')}</span></td></tr>`;
    })}</tbody></table></div>`
  : html`<p class="muted">None linked yet. Name the FBA shipment “${order.po} ${order.marketplace}”, or link it on the <a href="/shipments">Shipments</a> page.</p>`}

${batches.length
  ? html`<h2>Show working</h2>${batches.map((b) => html`<details><summary>${productName(ledger, b.product)} · ${b.shipment}</summary>${working(b)}</details>`)}`
  : ''}

<h2>Invoices</h2>
${(order.invoices || []).map((inv) => invoiceCard(order, inv, r.invoice?.id === inv.id, ledger))}
<details${order.invoices?.length ? '' : raw(' open')}><summary>Add ${order.invoices?.length ? 'the final invoice or another version' : 'the proforma or invoice'}</summary>
${invoiceForm(ctx, order, null)}</details>

<h2>Write-offs</h2>
<p class="muted small">Units that will never ship. Their cost moves to the units that did arrive.</p>
${(order.writeOffs || []).length ? html`<ul>${order.writeOffs.map((w) => html`<li>${productName(ledger, w.product)}: ${units(w.qty)} ${w.reason ? `(${w.reason})` : ''}</li>`)}</ul>` : ''}
<form class="card" method="post" action="/orders/${enc(order.po)}/write-offs">${versionField(order)}<div class="grid">
<div><label>Product</label>${select('product', r.lines.map((l) => ({ value: l.product, label: productName(ledger, l.product) })), null)}</div>
<div><label>Units</label><input name="qty" inputmode="decimal" required></div>
<div><label>Reason</label><input name="reason"></div></div><button class="ghost">Write off</button></form>

${history(ctx, 'order', order.po)}`;
  return { title: order.po, body };
}

export function working(batch) {
  return html`<dl class="working">${batch.working.map((s) => html`<dt>${s.label}</dt><dd>${s.text}</dd>`)}</dl>`;
}

export function history(ctx, entity, id) {
  const trail = auditTrail(ctx.db, { entity, id, limit: 10 });
  if (!trail.length) return '';
  return html`<details class="small"><summary>History</summary><ul>${trail.map((a) => html`<li>${a.at.slice(0, 16).replace('T', ' ')} · ${a.actor} · ${a.action}</li>`)}</ul></details>`;
}

function invoiceCard(order, inv, inUse, ledger) {
  return html`<div class="card"><b>${inv.kind === 'final' ? 'Final invoice' : 'Proforma'}</b> ${inv.date || ''} ${inv.supplierRef ? html`· supplier ref ${inv.supplierRef}` : ''}
  ${inUse ? badge(['In use', 'ok']) : html`<span class="muted small">replaced</span>`}
  <div class="scroll"><table><thead><tr><th>Kind</th><th>Product</th><th class="n">Qty</th><th class="n">RMB</th><th>Description</th></tr></thead><tbody>
  ${(inv.lines || []).map((l) => html`<tr><td>${l.kind}</td><td>${l.product ? productName(ledger, l.product) : ''}</td><td class="n">${l.qty ? units(l.qty) : ''}</td><td class="n">${rmb(l.rmb)}</td><td class="small">${l.description || ''}${l.category ? ` (${l.category})` : ''}</td></tr>`)}
  ${inv.statedTotalRmb ? html`<tr class="total"><td colspan="3">Invoice total</td><td class="n">${rmb(inv.statedTotalRmb)}</td><td></td></tr>` : ''}
  </tbody></table></div>
  <a href="/orders/${enc(order.po)}/invoices/${enc(inv.id)}">Edit</a>
  <form class="inline" method="post" action="/orders/${enc(order.po)}/invoices/${enc(inv.id)}/delete" style="margin-left:12px">${versionField(order)}<button class="danger">Delete</button></form></div>`;
}

export function invoiceForm(ctx, order, inv, { action, submit, head = '', version } = {}) {
  const { ledger } = ctx.data;
  const lines = [...(inv?.lines || [])];
  for (let i = 0; i < BLANK_LINES; i++) lines.push({});
  const products = productOptions(ledger, order.marketplace || undefined);
  return html`<form class="card" method="post" action="${action || `/orders/${enc(order.po)}/invoices${inv?.id ? `/${enc(inv.id)}` : ''}`}">
${head}
${version === undefined ? versionField(ctx.data.ledger.orders.find((o) => o.po === order.po) || null) : version}
<div class="grid">
  <div><label>Type</label>${select('kind', [{ value: 'proforma', label: 'Proforma' }, { value: 'final', label: 'Final invoice' }], inv?.kind || (order.invoices?.length ? 'final' : 'proforma'))}</div>
  <div><label>Date</label><input type="date" name="date" value="${inv?.date || ''}"></div>
  <div><label>Supplier’s invoice no.</label><input name="supplierRef" value="${inv?.supplierRef || ''}"></div>
  <div><label>Total on the invoice (RMB)</label><input name="statedTotalRmb" inputmode="decimal" value="${inv?.statedTotalRmb || ''}"></div>
</div>
<div class="scroll"><table class="rows"><thead><tr><th>Kind</th><th>Product</th><th>Qty</th><th>RMB</th><th>Description / category</th></tr></thead><tbody>
${lines.map((l) => html`<tr><td>${select('line_kind', LINE_KINDS, l.kind || 'goods')}</td><td>${select('line_product', products, l.product, { blank: true })}</td>
<td><input name="line_qty" inputmode="decimal" value="${l.qty || ''}"></td><td><input name="line_rmb" inputmode="decimal" value="${l.rmb || ''}"></td>
<td><input name="line_description" value="${l.description || l.category || ''}"></td></tr>`)}
</tbody></table></div>
<p class="muted small">Labour with a product is that product’s own cost; without one it’s shared by RMB share, as are fees and adjustments. Expenses (packing bags, samples, R&amp;D) stay out of landing cost — put the category in the description.</p>
<button>${submit || (inv ? 'Save invoice' : 'Add invoice')}</button></form>`;
}

export function editInvoicePage(ctx) {
  const order = findOrder(ctx, ctx.params[0]);
  const inv = (order.invoices || []).find((i) => i.id === ctx.params[1]);
  if (!inv) throw new HttpError(404, 'Invoice not found');
  return { title: `Edit invoice · ${order.po}`, body: html`<p class="muted small"><a href="/orders/${enc(order.po)}">${order.po}</a></p><h1>Edit ${inv.kind} · ${order.po}</h1>${invoiceForm(ctx, order, inv)}` };
}

export function saveInvoice(ctx) {
  const current = findOrder(ctx, ctx.params[0]);
  assertFresh(ctx, 'order', current.po, current, `/orders/${enc(current.po)}`);
  const order = structuredClone(current);
  const existingId = ctx.params[1];
  const invoice = invoiceFromForm(ctx.form, order, ctx.data.ledger, existingId);
  order.invoices = existingId ? order.invoices.map((i) => (i.id === existingId ? invoice : i)) : [...(order.invoices || []), invoice];
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  return { redirect: `/orders/${enc(order.po)}?ok=${enc(`${invoice.kind === 'final' ? 'Final invoice' : 'Proforma'} saved.`)}` };
}

/** An invoice from the invoice form (used by order pages and the invoice-upload review). */
export function invoiceFromForm(f, order, ledger, existingId = null, extra = {}) {
  const kind = text(f, 'kind') === 'final' ? 'final' : 'proforma';
  const invDate = date(f.get('date'), 'Invoice date');
  const productIds = new Set(ledger.products.map((p) => p.id));

  const lines = rows(f, 'line', ['kind', 'product', 'qty', 'rmb', 'description'], ['product', 'qty', 'rmb', 'description']).map((l, i) => {
    const where = `Line ${i + 1}`;
    if (l.product && !productIds.has(l.product)) throw new HttpError(400, `${where}: unknown product`);
    if (l.kind === 'goods' && !l.product) throw new HttpError(400, `${where}: goods need a product`);
    if (l.kind === 'goods' && !l.qty) throw new HttpError(400, `${where}: goods need a quantity`);
    const line = compact({ kind: l.kind, product: l.product || undefined, qty: number(l.qty, `${where} qty`), rmb: number(l.rmb, `${where} RMB`) });
    if (l.description) line[l.kind === 'expense' ? 'category' : 'description'] = l.description;
    return line;
  });
  if (!lines.some((l) => l.kind === 'goods')) throw new HttpError(400, 'An invoice needs at least one goods line');

  const taken = new Set((order.invoices || []).filter((i) => i.id !== existingId).map((i) => i.id));
  const id = existingId || uniqueId(`${order.po}-${kind}-${invDate || 'undated'}`, taken);
  const previous = existingId ? (order.invoices || []).find((i) => i.id === existingId) : null;
  const invoice = compact({ id, kind, date: invDate, supplierRef: text(f, 'supplierRef'), statedTotalRmb: number(f.get('statedTotalRmb'), 'Invoice total'), filePath: previous?.filePath, ...extra });
  invoice.lines = lines;
  return invoice;
}

export function deleteInvoice(ctx) {
  const current = findOrder(ctx, ctx.params[0]);
  assertFresh(ctx, 'order', current.po, current, `/orders/${enc(current.po)}`);
  const order = structuredClone(current);
  order.invoices = (order.invoices || []).filter((i) => i.id !== ctx.params[1]);
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  return { redirect: `/orders/${enc(order.po)}?ok=Invoice+deleted.` };
}

export function markReviewed(ctx) {
  const current = findOrder(ctx, ctx.params[0]);
  assertFresh(ctx, 'order', current.po, current, `/orders/${enc(current.po)}`);
  const order = structuredClone(current);
  order.review = 'reviewed';
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  const back = ctx.form.get('back');
  return { redirect: `${back === '/' ? '/' : `/orders/${enc(order.po)}`}?ok=${enc(`${order.po} marked checked.`)}` };
}

export function addWriteOff(ctx) {
  const current = findOrder(ctx, ctx.params[0]);
  assertFresh(ctx, 'order', current.po, current, `/orders/${enc(current.po)}`);
  const order = structuredClone(current);
  const f = ctx.form;
  const product = required(text(f, 'product'), 'Product');
  const qty = required(number(f.get('qty'), 'Units'), 'Units');
  order.writeOffs = [...(order.writeOffs || []), compact({ product, qty, reason: text(f, 'reason'), date: new Date().toISOString().slice(0, 10) })];
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  return { redirect: `/orders/${enc(order.po)}?ok=Written+off.` };
}
