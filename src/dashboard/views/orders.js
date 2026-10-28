import { html, raw, select, badge, statusBadge, rmb, units, pct, unitCost, money, BATCH_STATUS, PAID_STATUS, shipmentStatusLabel } from '../html.js';
import { poTasksSection } from './tasks.js';
import { documentsSection } from './files.js';
import { listAttachments, removeAttachment } from '../../files/attachments.js';
import { tasksForPo, saveTask } from '../../tasks/board.js';
import { saveLedger, nextPo, auditTrail, deleteRecord } from '../../landing/store.js';
import { currentInvoices } from '../../landing/engine.js';
import { text, number, date, required, rows, compact, uniqueId } from '../forms.js';
import { HttpError } from '../errors.js';
import { MARKETPLACES, productOptions, findOrder, productName, enc, supplierOptions } from './common.js';
import { versionField, assertFresh } from '../versions.js';

const LINE_KINDS = [
  { value: 'goods', label: 'Goods' },
  { value: 'labour', label: 'Labour' },
  { value: 'fee', label: 'Fee (e.g. Annie 1%)' },
  { value: 'adjustment', label: 'Adjustment (rate diff, re-price)' },
  { value: 'expense', label: 'Expense (not landing cost)' },
];
const BLANK_LINES = 6;

/**
 * The supplier invoices on a PO, each with its versions (proforma, final,
 * corrections) oldest first, and the one that counts.
 */
export function invoiceSeries(order) {
  const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || ''));
  const groups = new Map();
  for (const inv of order.invoices || []) {
    const key = inv.series || 'main';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(inv);
  }
  const current = new Set(currentInvoices(order).map((i) => i.id));
  return [...groups.entries()]
    .map(([key, versions]) => {
      versions.sort(byDate);
      const inUse = versions.find((v) => current.has(v.id));
      const name = [inUse?.supplier, inUse?.supplierRef ? `no. ${inUse.supplierRef}` : null].filter(Boolean).join(' ') || `${inUse?.kind === 'final' ? 'final' : 'proforma'} ${inUse?.date || ''}`.trim();
      return { key, versions, inUse, name };
    })
    .sort((a, b) => byDate(a.versions[0], b.versions[0]));
}

/* ---------------------------- list ---------------------------- */

// Where an order is in its life, for the list and its filter.
export const STAGES = {
  unpaid: ['Not paid', 'bad'],
  deposit: ['Deposit paid', 'wait'],
  ready: ['Paid, not shipped', 'est'],
  shipping: ['Shipped / receiving', 'wait'],
  complete: ['Received', 'ok'],
};

export function orderStage(r, ledger) {
  if (r.paidStatus === 'unpaid') return 'unpaid';
  if (r.paidStatus === 'deposit_paid') return 'deposit';
  const shipped = ledger.shipments.some((s) => s.items.some((i) => i.po === r.po));
  if (!shipped) return 'ready';
  return r.lines.length && r.lines.every((l) => l.basis === 'received') ? 'complete' : 'shipping';
}

const PAGE_SIZE = 20;

/** How POs work, shown on the Orders page. Each rule is something the system enforces or relies on. */
export const PO_RULES = [
  ['One PO is one purchase', 'Everything ordered together and paid together: a deposit and a balance. Create the PO before paying the deposit, and never reuse a PO number. The next one is suggested.'],
  ['One marketplace per PO', 'UK, DE or US. UK and DE are costed in GBP, the US in USD. Ordering for two marketplaces at once means two POs; they can still be paid in one transfer.'],
  ['A PO can hold several supplier invoices', 'From one supplier or several (e.g. Yongbo and Hongtai through Annie). When you add an invoice, say whether it replaces one already on the PO (a final after a proforma, or a corrected version) or is another invoice added to the others.'],
  ['The latest version of each invoice counts', 'The final if there is one, otherwise the proforma. Replaced versions are kept for the record but don’t count. Each invoice’s fees, labour and rate differences stay with that invoice’s products.'],
  ['Deposit and balance go to the same PO', 'Wise reference “PO-041 30%” for the deposit and “PO-041 balance” for the rest, covering every invoice on the PO. The supplier doesn’t need to print the PO; it’s linked when you upload the invoice.'],
  ['One transfer can pay several POs', 'And courier bills, packing bags or samples. Record one row per PO (or bill), each with the amount its invoice asks for, all in USD or all in RMB. The transfer is split by those amounts. Suppliers are paid in USD or RMB; you can fund it from USD, GBP or EUR.'],
  ['What a unit costs', 'The cash actually paid, never the invoice price: GBP actually paid, or USD/EUR × the QB rate on the payment date, for the UK and DE; USD sent for the US. Within a PO it’s shared by RMB, so a product carrying 60% of the RMB carries 60% of the cash. Wise fees, packing bags, samples and R&D are expenses, not landing cost.'],
  ['When a PO is fully paid', 'When its payments add up to the RMB of all its current invoices, or a payment is marked balance or full. Until then the cost is projected from the deposit.'],
  ['Put the PO in the shipment name', '“PO-041 UK” in Send to Amazon links the shipment by itself. A shipment carrying two POs: “PO-041 PO-043 UK”. If the same product comes from both, split the units on the shipment’s page.'],
  ['Units a cost is divided by', 'Units ordered until every unit has shipped and every shipment has closed, then units Amazon received. Units that will never ship are written off on the order, and their cost moves to the units that arrived.'],
  ['Courier bills attach by FBA ID, not PO', 'Each line of Annie’s bill names its shipment. Until the bill arrives, delivery is estimated from the last shipment of the same product. Goods sent to a 3PL or your home first are held on the bill until they go to Amazon; the steps are on the Courier bills page.'],
  ['Sellerboard', 'A batch goes to Sellerboard the day Amazon starts receiving it, dated that day, once its PO has been checked.'],
];

export function ordersPage(ctx) {
  const { ledger, result } = ctx.data;
  const byPo = new Map(result.orders.map((o) => [o.po, o]));
  const q = ctx.url.searchParams;
  const filters = {
    market: MARKETPLACES.includes(q.get('market')) ? q.get('market') : '',
    stage: STAGES[q.get('stage')] ? q.get('stage') : '',
    check: ['to_check', 'checked'].includes(q.get('check')) ? q.get('check') : '',
    q: (q.get('q') || '').trim(),
  };

  const needle = filters.q.toLowerCase();
  const matching = [...ledger.orders]
    .sort((x, y) => Number(y.po.replace(/\D/g, '')) - Number(x.po.replace(/\D/g, '')) || y.po.localeCompare(x.po)) // newest first
    .map((o) => ({ o, r: byPo.get(o.po) }))
    .map((x) => ({ ...x, stage: orderStage(x.r, ledger) }))
    .filter(({ o, stage }) => {
      if (filters.market && o.marketplace !== filters.market) return false;
      if (filters.stage && stage !== filters.stage) return false;
      if (filters.check === 'to_check' && o.review !== 'needs_review') return false;
      if (filters.check === 'checked' && o.review === 'needs_review') return false;
      if (needle) {
        const products = byPo.get(o.po).lines.map((l) => productName(ledger, l.product)).join(' ');
        if (![o.po, o.supplier, products].join(' ').toLowerCase().includes(needle)) return false;
      }
      return true;
    });

  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(q.get('page'), 10) || 1));
  const shown = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const link = (n) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    if (n > 1) params.set('page', n);
    const qs = params.toString();
    return `/orders${qs ? `?${qs}` : ''}`;
  };
  const filtered = Object.values(filters).some(Boolean);

  const body = html`
<h1>Orders</h1>
<p class="sub">One page per order, in place of a 30% tab and a 70% tab that have to find each other.</p>
<details class="card" id="rules"><summary><b>How POs work: the rules</b></summary>
<ol class="rules">${PO_RULES.map(([title, text]) => html`<li><b>${title}.</b> ${text}</li>`)}</ol></details>
<form class="card" method="post" action="/orders">
<h2 style="margin-top:0">New order</h2>
<div class="grid">
  <div><label>PO number (required)</label><input name="po" value="${nextPo(ctx.db)}" required pattern="PO-\\d+"></div>
  <div><label for="n-supplier">Supplier (required)</label>${select('supplier', supplierOptions(ctx), '', { blank: true, attrs: 'id="n-supplier" required' })}</div>
  <div><label>Marketplace</label>${select('marketplace', MARKETPLACES, 'UK')}</div>
  <div><label>Notes</label><input name="notes"></div>
</div>
<button>Create order</button> <span class="muted small">Supplier not listed? <a href="/settings#suppliers">Add it in Settings</a>. Then add its proforma or invoice. Use the PO in the Wise reference (e.g. “${nextPo(ctx.db)} 30%”) and in the FBA shipment name.</span>
</form>

<h2>Orders</h2>

<form class="card" method="get" action="/orders"><div class="grid" style="margin-bottom:8px">
  <div><label>Market</label>${select('market', [{ value: '', label: 'All' }, ...MARKETPLACES], filters.market)}</div>
  <div><label>Status</label>${select('stage', [{ value: '', label: 'All' }, ...Object.entries(STAGES).map(([value, [label]]) => ({ value, label }))], filters.stage)}</div>
  <div><label>Checked</label>${select('check', [{ value: '', label: 'All' }, { value: 'to_check', label: 'To check' }, { value: 'checked', label: 'Checked' }], filters.check)}</div>
  <div><label>Search</label><input name="q" value="${filters.q}" placeholder="PO, supplier or product"></div>
</div>
<button class="ghost">Filter</button>${filtered ? html` <a href="/orders" style="margin-left:10px">Clear</a>` : ''}
</form>

<p class="muted small">${matching.length ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + shown.length} of ${matching.length}` : 'No orders match'}${filtered ? ` (of ${ledger.orders.length} in all)` : ''}</p>
${shown.length
  ? html`<div class="card scroll"><table>
<thead><tr><th>PO</th><th>Supplier</th><th>Mkt</th><th>Products</th><th>Invoice</th><th class="n">RMB</th><th class="key">Status</th><th></th></tr></thead>
<tbody>${shown.map(({ o, r, stage }) => html`<tr><td><a href="/orders/${enc(o.po)}">${o.po}</a></td><td>${o.supplier}</td><td>${o.marketplace}</td>
  <td class="small">${r.lines.map((l, i) => html`${i ? ', ' : ''}${productName(ledger, l.product)} ×${units(l.ordered)}`)}</td>
  <td class="small">${r.invoices.length > 1 ? `${r.invoices.length} invoices` : r.invoice ? `${r.invoice.kind} ${r.invoice.date || ''}` : '—'}</td><td class="n">${rmb(r.totalRmb)}</td>
  <td>${badge(STAGES[stage])}</td><td>${o.review === 'needs_review' ? badge(['To check', 'warn']) : ''}</td></tr>`)}</tbody></table></div>`
  : ''}
${pages > 1
  ? html`<p class="pager">${page > 1 ? html`<a href="${link(page - 1)}">← Newer</a>` : html`<span class="muted">← Newer</span>`}
  <span class="muted">Page ${page} of ${pages}</span>
  ${page < pages ? html`<a href="${link(page + 1)}">Older →</a>` : html`<span class="muted">Older →</span>`}</p>`
  : ''}`;
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
<p class="small" style="margin:4px 0">${badge(PAID_STATUS[r.paidStatus])} ${moneyLine(r)}</p>
<p>
${order.review === 'needs_review'
  ? html` ${badge(['Imported, to check', 'warn'])} <form class="inline" method="post" action="/orders/${enc(order.po)}/review">${versionField(order)}<button class="ghost">Mark checked</button></form>`
  : ''}</p>
${order.notes ? html`<p class="sub">${order.notes}</p>` : ''}
<details class="small"><summary>Edit PO details</summary>${editOrderForm(ctx, order)}</details>
${order.importNotes?.length
  ? html`<div class="notice"><b>Imported from ${order.source || 'the sheet'}.</b> Check against the sheet before marking it checked.<ul>${order.importNotes.map((n) => html`<li>${n}</li>`)}</ul></div>`
  : ''}

<h2>Products${r.invoices.length ? html` <span class="muted small">· ${r.invoices.length > 1 ? `${r.invoices.length} invoices` : `${r.invoice.kind} invoice ${r.invoice.date || ''}`} · ${rmb(r.totalRmb)} RMB</span>` : ''}</h2>
<div class="card scroll"><table>
<thead><tr><th>Product</th><th class="n">Units</th><th class="n">RMB share</th><th class="n">Line cost</th><th class="n">Product / unit</th><th>Divided by</th><th class="n key">Landing / unit</th></tr></thead>
<tbody>${r.lines.map((l) => {
  const landings = batches.filter((b) => b.product === l.product && b.landingCost !== null);
  return html`<tr><td>${productName(ledger, l.product)}</td><td class="n">${units(l.ordered)}</td><td class="n">${pct(l.fraction)}</td>
  <td class="n">${money(l.cost, cur)}${l.projected ? '*' : ''}</td><td class="n">${unitCost(l.unitCost, cur)}</td>
  <td class="small">${units(l.divisor)} ${l.basis}</td>
  <td class="n">${landings.length ? landings.map((b, i) => html`${i ? raw('<br>') : ''}${unitCost(b.landingCost, cur)} <span class="muted small">${b.shipment}</span>`) : '—'}</td></tr>`;
})}</tbody></table>
${r.lines.some((l) => l.projected) ? html`<p class="muted small">* Only the deposit is paid, so the full cost is projected at the deposit’s rate.</p>` : ''}
</div>

<h2>Shipments from this order</h2>
${shipments.length
  ? html`<div class="card scroll"><table><thead><tr><th>Shipment</th><th>Status</th><th class="n">Shipped</th><th class="n">Received</th><th class="n key">Delivery / unit</th></tr></thead><tbody>${shipments.map((s) => {
      const sr = shipmentResults.get(s.id);
      const mine = s.items.filter((i) => i.po === order.po);
      return html`<tr><td><a href="/shipments/${enc(s.id)}">${s.id}</a></td><td>${statusBadge(s.status)}</td>
      <td class="n">${units(mine.reduce((a, i) => a + Number(i.shipped || 0), 0))}</td><td class="n">${sr?.closed ? units(mine.reduce((a, i) => a + Number(i.received || 0), 0)) : '—'}</td>
      <td class="n">${unitCost(sr?.delivery.perUnit, cur)} <span class="muted small">${sr?.delivery.basis === 'estimated' ? 'est.' : sr?.delivery.bills.map((b) => b.bill).join(', ')}</span></td></tr>`;
    })}</tbody></table></div>`
  : html`<p class="muted">None linked yet. Name the FBA shipment “${order.po} ${order.marketplace}”, or link it on the <a href="/shipments">Shipments</a> page.</p>`}

${batches.length
  ? html`<h2>Show working</h2>${batches.map((b) => html`<details><summary>${productName(ledger, b.product)} · ${b.shipment}</summary>${working(b)}</details>`)}`
  : ''}

${poTasksSection(ctx, order.po)}

<h2>Invoices${r.invoices.length > 1 ? html` <span class="muted small">· ${r.invoices.length} invoices on this PO, added together</span>` : ''}</h2>
${invoiceSeries(order).map((g, i, all) => html`${all.length > 1 ? html`<h3>Invoice ${i + 1}: ${g.name}</h3>` : ''}${g.versions.map((inv) => invoiceCard(ctx, order, inv, g.inUse?.id === inv.id, ledger, all.length === 1 && g.inUse?.id === inv.id ? paidPanel(ctx, order, r) : ''))}`)}
${invoiceSeries(order).length > 1 || (!order.invoices?.length && r.payments.length) ? html`<div class="card">${paidPanel(ctx, order, r, { several: invoiceSeries(order).length > 1 })}</div>` : ''}
<form class="card" method="post" action="/invoices/upload" enctype="multipart/form-data"><input type="hidden" name="po" value="${order.po}">
<label for="inv-file"><b>${order.invoices?.length ? 'Upload an invoice: the final, a corrected version, or another invoice on this PO' : 'Upload the proforma or invoice'}</b> (Excel, PDF or photo)</label>
<input id="inv-file" type="file" name="file" required accept=".xlsx,.pdf,.jpg,.jpeg,.png,.webp,.heic">
<p><button>Read invoice</button> <span class="muted small">It's read for you${ctx.invoiceReader ? '' : ' (Excel only here: PDFs and photos need typing in)'}, then you check it and save it to ${order.po}.</span></p></form>
<details><summary>Or type it in by hand</summary>
${invoiceForm(ctx, order, null)}</details>

${documentsSection(ctx, 'order', order.po, { back: `/orders/${enc(order.po)}`, hint: 'e.g. packing list, contract, photos of the goods' })}

<h2>Write-offs</h2>
<p class="muted small">Units that will never ship. Their cost moves to the units that did arrive.</p>
${(order.writeOffs || []).length ? html`<ul class="docs">${order.writeOffs.map((w, i) => html`<li>${productName(ledger, w.product)}: ${units(w.qty)} ${w.reason ? `(${w.reason})` : ''} <span class="muted small">${w.date || ''}</span>
<form class="inline" method="post" action="/orders/${enc(order.po)}/write-offs/${i}/delete" data-confirm="Remove this write-off of ${units(w.qty)} ${productName(ledger, w.product)}?">${versionField(order)}<button class="ghost small">Remove</button></form></li>`)}</ul>` : ''}
<form class="card" method="post" action="/orders/${enc(order.po)}/write-offs">${versionField(order)}<div class="grid">
<div><label>Product</label>${select('product', r.lines.map((l) => ({ value: l.product, label: productName(ledger, l.product) })), null)}</div>
<div><label>Units</label><input name="qty" inputmode="decimal" required></div>
<div><label>Reason (required)</label><input name="reason" required></div></div><button class="ghost">Write off</button></form>

<form method="post" action="/orders/${enc(order.po)}/delete" data-confirm="Delete ${order.po} with its invoices, write-offs and documents? This can't be undone.">${versionField(order)}<button class="danger">Delete this PO</button>
<span class="muted small">Only for a PO created by mistake. Payments and shipments must be deleted or moved first.</span></form>
${history(ctx, 'order', order.po)}`;
  return { title: order.po, body };
}

export function working(batch) {
  return html`<dl class="working">${batch.working.map((s) => html`<dt>${s.label}</dt><dd>${s.text}</dd>`)}</dl>`;
}

/** The order's money in one line: paid, against how much, what's left, at what rate. */
function moneyLine(r) {
  const cur = r.currency;
  const bits = [];
  if (r.cash !== null && r.cash !== undefined && r.payments.length) bits.push(`${money(r.cash, cur)} paid`);
  if (r.paidRmb !== null && r.paidRmb !== undefined && r.totalRmb !== null && r.totalRmb !== undefined) {
    bits.push(`for ${rmb(r.paidRmb)} of ${rmb(r.totalRmb)} RMB`);
    const left = r.totalRmb.minus(r.paidRmb);
    if (left.gt(0) && r.paidStatus !== 'paid') bits.push(`${rmb(left)} RMB outstanding`);
  } else if (r.totalRmb !== null && r.totalRmb !== undefined && !r.payments.length) bits.push(`${rmb(r.totalRmb)} RMB invoiced, nothing paid yet`);
  if (r.paidRmb?.gt(0) && r.cash?.gt(0)) bits.push(`rate ≈ ${r.paidRmb.div(r.cash).toFixed(2)} RMB per ${cur === 'GBP' ? '£' : '$'}`);
  if (r.paidStatus === 'deposit_paid' && r.costBasis) bits.push(`full cost projected at ${money(r.costBasis, cur)}`);
  return bits.join(' · ');
}

/** What's been paid against the order, inside the invoice it pays, with the next payment's button. */
function paidPanel(ctx, order, r, { several = false } = {}) {
  const cur = r.currency;
  const po = enc(order.po);
  const receipts = (id) => listAttachments(ctx.db, 'payment', id).length;
  const button =
    r.paidStatus === 'paid'
      ? html`<a href="/payments/new?po=${po}">Record another payment</a>`
      : r.paidStatus === 'deposit_paid'
        ? html`<a class="button" href="/payments/new?po=${po}&amp;part=balance">Pay balance</a> <a href="/payments/new?po=${po}" style="margin-left:10px">Other payment</a>`
        : order.invoices?.length
          ? html`<a class="button" href="/payments/new?po=${po}&amp;part=deposit">Pay deposit</a> <a class="button ghost" href="/payments/new?po=${po}&amp;part=full" style="margin-left:6px">Pay in full</a> <a href="/payments/new?po=${po}" style="margin-left:10px">Other payment</a>`
          : html`<a href="/payments/new?po=${po}">Record a payment</a>`;
  return html`<div class="paid"><h3>${several ? `Paid against ${order.po} (all its invoices)` : 'Paid'}</h3>
${r.payments.length
  ? html`<ul class="docs">${r.payments.map((p) => html`<li><a href="/payments/${enc(p.payment)}">${p.date}</a> · ${p.part ? html`<b>${p.part[0].toUpperCase() + p.part.slice(1)}</b>` : 'Payment'} · ${money(p.amount, cur)}${p.rmb && !p.rmb.isNaN?.() ? html` · ${rmb(p.rmb)} RMB` : ''}
  <span class="muted small">${p.reference || ''}${receipts(p.payment) ? ` · ${receipts(p.payment)} receipt${receipts(p.payment) === 1 ? '' : 's'}` : ' · no receipt yet'}</span></li>`)}</ul>`
  : html`<p class="muted small">Nothing paid yet.</p>`}
<p>${button}</p></div>`;
}

export function history(ctx, entity, id) {
  const trail = auditTrail(ctx.db, { entity, id, limit: 10 });
  if (!trail.length) return '';
  return html`<details class="small"><summary>History</summary><ul>${trail.map((a) => html`<li>${a.at.slice(0, 16).replace('T', ' ')} · ${a.actor} · ${a.action}</li>`)}</ul></details>`;
}

function invoiceCard(ctx, order, inv, inUse, ledger, paid = '') {
  return html`<div class="card"><b>${inv.kind === 'final' ? 'Final invoice' : 'Proforma'}</b> ${inv.date || ''} ${inv.supplier ? html`· ${inv.supplier}` : ''} ${inv.supplierRef ? html`· supplier ref ${inv.supplierRef}` : ''}
  ${inUse ? badge(['In use', 'ok']) : html`<span class="muted small">replaced</span>`}
  <div class="scroll"><table><thead><tr><th>Kind</th><th>Product</th><th class="n">Qty</th><th class="n">RMB</th><th>Description</th></tr></thead><tbody>
  ${(inv.lines || []).map((l) => html`<tr><td>${l.kind}</td><td>${l.product ? productName(ledger, l.product) : ''}</td><td class="n">${l.qty ? units(l.qty) : ''}</td><td class="n">${rmb(l.rmb)}</td><td class="small">${l.description || ''}${l.category ? ` (${l.category})` : ''}</td></tr>`)}
  ${inv.statedTotalRmb ? html`<tr class="total"><td colspan="3">Invoice total</td><td class="n">${rmb(inv.statedTotalRmb)}</td><td></td></tr>` : ''}
  </tbody></table></div>
  ${paid}
  ${!inUse && invoiceSeries(order).length === 1 ? html`<p class="muted small">Payments show on the invoice in use.</p>` : ''}
  <div class="small" style="margin:6px 0">${documentsSection(ctx, 'invoice', inv.id, {
    heading: false,
    back: `/orders/${enc(order.po)}`,
    hint: 'e.g. signed copy',
    extra: inv.filePath ? [{ href: `/orders/${enc(order.po)}/invoices/${enc(inv.id)}/file`, label: 'Original invoice file', meta: 'as uploaded or forwarded' }] : [],
  })}</div>
  <a href="/orders/${enc(order.po)}/invoices/${enc(inv.id)}">Edit</a>
  <form class="inline" method="post" action="/orders/${enc(order.po)}/invoices/${enc(inv.id)}/delete" style="margin-left:12px" data-confirm="Delete this ${inv.kind === 'final' ? 'final invoice' : 'proforma'} from ${order.po}?">${versionField(order)}<button class="danger">Delete</button></form></div>`;
}

export function invoiceForm(ctx, order, inv, { action, submit, head = '', version } = {}) {
  const { ledger } = ctx.data;
  const lines = [...(inv?.lines || [])];
  for (let i = 0; i < BLANK_LINES; i++) lines.push({});
  const products = productOptions(ledger, order.marketplace || undefined);
  return html`<form class="card" method="post" action="${action || `/orders/${enc(order.po)}/invoices${inv?.id ? `/${enc(inv.id)}` : ''}`}">
${head}
${version === undefined ? versionField(ctx.data.ledger.orders.find((o) => o.po === order.po) || null) : version}
${!inv?.id && order.invoices?.length
  ? html`<div class="notice" style="margin-top:0"><label style="color:inherit"><b>This invoice…</b></label>${select('series', [
      { value: '', label: '— choose —' },
      ...invoiceSeries(order).map((g, i) => ({ value: g.key, label: `replaces invoice ${i + 1} (${g.name}): a final, or a corrected version` })),
      { value: 'new', label: 'is another invoice on this PO, added to the others' },
    ], inv?.seriesChoice || '', { attrs: 'required' })}</div>`
  : ''}
<div class="grid">
  <div><label>Type</label>${select('kind', [{ value: 'proforma', label: 'Proforma' }, { value: 'final', label: 'Final invoice' }], inv?.kind || (order.invoices?.length ? 'final' : 'proforma'))}</div>
  <div><label>Date (required)</label><input type="date" name="date" value="${inv?.date || ''}" required></div>
  <div><label>Supplier’s invoice no.</label><input name="supplierRef" value="${inv?.supplierRef || ''}"></div>
  <div><label>Total on the invoice, RMB (required)</label><input name="statedTotalRmb" inputmode="decimal" value="${inv?.statedTotalRmb || ''}" required></div>
  <div><label>Supplier, if not ${order.supplier || 'the PO’s'}</label>${select('invoiceSupplier', [{ value: '', label: `Same as the PO${order.supplier ? ` (${order.supplier})` : ''}` }, ...supplierOptions(ctx, inv?.supplier).filter((n) => n !== order.supplier)], inv?.supplier || '')}</div>
</div>
<div class="scroll"><table class="rows" data-need-first><thead><tr><th>Kind</th><th>Product</th><th>Qty</th><th>RMB</th><th>Description / category</th></tr></thead><tbody>
${lines.map((l) => html`<tr><td>${select('line_kind', LINE_KINDS, l.kind || 'goods')}</td><td>${select('line_product', products, l.product, { blank: true, attrs: 'data-need="goods"' })}</td>
<td><input name="line_qty" inputmode="decimal" value="${l.qty || ''}" data-need="goods"></td><td><input name="line_rmb" inputmode="decimal" value="${l.rmb || ''}" data-need="any"></td>
<td><input name="line_description" value="${l.description || l.category || ''}" data-need="adjustment expense"></td></tr>`)}
</tbody></table></div>
<p class="muted small"><b>Required on each line you use:</b> the RMB; for goods, the product and quantity; for an adjustment or expense, what it is. Labour with a product is that product’s own cost; without one it’s shared by RMB share, as are fees and adjustments. Expenses (packing bags, samples, R&amp;D) stay out of landing cost — put the category in the description.</p>
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
  const invDate = date(f.get('date'), 'Invoice date', { required: true });
  const productIds = new Set(ledger.products.map((p) => p.id));

  const lines = rows(f, 'line', ['kind', 'product', 'qty', 'rmb', 'description'], ['product', 'qty', 'rmb', 'description']).map((l, i) => {
    const where = `Line ${i + 1}`;
    if (l.product && !productIds.has(l.product)) throw new HttpError(400, `${where}: unknown product`);
    if (l.kind === 'goods' && !l.product) throw new HttpError(400, `${where}: goods need a product`);
    if (l.kind === 'goods' && !l.qty) throw new HttpError(400, `${where}: goods need a quantity`);
    if (!l.rmb) throw new HttpError(400, `${where}: enter its RMB amount`);
    if ((l.kind === 'adjustment' || l.kind === 'expense') && !l.description) throw new HttpError(400, `${where}: say what the ${l.kind} is`);
    const line = compact({ kind: l.kind, product: l.product || undefined, qty: number(l.qty, `${where} qty`), rmb: number(l.rmb, `${where} RMB`) });
    if (l.description) line[l.kind === 'expense' ? 'category' : 'description'] = l.description;
    return line;
  });
  if (!lines.some((l) => l.kind === 'goods')) throw new HttpError(400, 'An invoice needs at least one goods line');

  const taken = new Set((order.invoices || []).filter((i) => i.id !== existingId).map((i) => i.id));
  const id = existingId || uniqueId(`${order.po}-${kind}-${invDate || 'undated'}`, taken);
  const previous = existingId ? (order.invoices || []).find((i) => i.id === existingId) : null;

  // Which supplier invoice this is a version of. Editing keeps it; a new one
  // on a PO that already has invoices must say whether it replaces one or adds to them.
  let series;
  if (previous) series = previous.series;
  else if (!(order.invoices || []).length) series = id;
  else {
    const choice = text(f, 'series');
    const keys = new Set(invoiceSeries(order).map((g) => g.key));
    if (!choice) throw new HttpError(400, 'Say whether this invoice replaces one already on the PO, or is another invoice added to them.');
    if (choice === 'new') series = id;
    else if (keys.has(choice)) series = choice === 'main' ? undefined : choice;
    else throw new HttpError(400, 'That invoice is no longer on this PO. Reload and choose again.');
  }

  const invoice = compact({ id, kind, date: invDate, supplierRef: text(f, 'supplierRef'), supplier: text(f, 'invoiceSupplier'), statedTotalRmb: required(number(f.get('statedTotalRmb'), 'Invoice total'), 'Total on the invoice'), filePath: previous?.filePath, series, ...extra });
  invoice.lines = lines;
  return invoice;
}

export function deleteInvoice(ctx) {
  const current = findOrder(ctx, ctx.params[0]);
  assertFresh(ctx, 'order', current.po, current, `/orders/${enc(current.po)}`);
  const order = structuredClone(current);
  order.invoices = (order.invoices || []).filter((i) => i.id !== ctx.params[1]);
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  for (const a of listAttachments(ctx.db, 'invoice', ctx.params[1])) removeAttachment(ctx.db, a.id, { actor: ctx.actor });
  return { redirect: `/orders/${enc(order.po)}?ok=Invoice+deleted.` };
}

/**
 * Deletes a PO created by mistake, with its invoices, write-offs and documents.
 * Refused while payments or shipments still point at it: delete or move those
 * first, so no money or stock is left pointing at nothing. Linked tasks are kept, unlinked.
 */
/** Why an order's marketplace can't change any more: its products, currency and shipments are per marketplace. */
function marketplaceLocked(ctx, order) {
  const { ledger } = ctx.data;
  if ((order.invoices || []).length) return 'it has invoices';
  if (ledger.payments.some((p) => p.allocations.some((a) => a.type === 'order' && a.target === order.po))) return 'it has payments';
  if (ledger.shipments.some((s) => s.items.some((i) => i.po === order.po))) return 'shipments are linked to it';
  return null;
}

function editOrderForm(ctx, order) {
  const locked = marketplaceLocked(ctx, order);
  return html`<form class="card" method="post" action="/orders/${enc(order.po)}/edit">${versionField(order)}<div class="grid">
<div><label>PO number</label><input value="${order.po}" disabled></div>
<div><label for="o-supplier">Supplier (required)</label>${select('supplier', supplierOptions(ctx, order.supplier), order.supplier, { blank: true, attrs: 'id="o-supplier" required' })}</div>
<div><label for="o-market">Marketplace${locked ? ' (fixed: ' + locked + ')' : ''}</label>${select('marketplace', MARKETPLACES, order.marketplace, { attrs: locked ? 'id="o-market" disabled' : 'id="o-market"' })}</div>
<div><label for="o-notes">Notes</label><input id="o-notes" name="notes" value="${order.notes || ''}"></div>
</div><p class="muted small">The PO number can't change: it's in the Wise references and the shipment names in Seller Central. If it's wrong, delete this PO and create it again.</p>
<button>Save PO details</button></form>`;
}

export function editOrder(ctx) {
  const order = findOrder(ctx, ctx.params[0]);
  const back = `/orders/${enc(order.po)}`;
  assertFresh(ctx, 'order', order.po, order, back);
  const supplier = required(text(ctx.form, 'supplier'), 'Supplier');
  let marketplace = order.marketplace;
  const asked = text(ctx.form, 'marketplace');
  if (asked && asked !== order.marketplace) {
    const locked = marketplaceLocked(ctx, order);
    if (locked) throw Object.assign(new HttpError(400, `${order.po}'s marketplace can't change now that ${locked}.`), { back });
    if (!MARKETPLACES.includes(asked)) throw Object.assign(new HttpError(400, 'Choose UK, DE or US'), { back });
    marketplace = asked;
  }
  const updated = { ...structuredClone(order), supplier, marketplace, notes: text(ctx.form, 'notes') };
  if (!updated.notes) delete updated.notes;
  saveLedger(ctx.db, { orders: [updated] }, { actor: ctx.actor });
  return { redirect: `${back}?ok=${enc(`${order.po} saved.`)}` };
}

/** Takes off a write-off entered by mistake (by its position in the list). */
export function removeWriteOff(ctx) {
  const current = findOrder(ctx, ctx.params[0]);
  const back = `/orders/${enc(current.po)}`;
  assertFresh(ctx, 'order', current.po, current, back);
  const i = Number(ctx.params[1]);
  if (!Number.isInteger(i) || !(current.writeOffs || [])[i]) throw Object.assign(new HttpError(400, 'That write-off is no longer there. Reload and try again.'), { back });
  const order = structuredClone(current);
  order.writeOffs.splice(i, 1);
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  return { redirect: `${back}?ok=Write-off+removed.` };
}

export function deleteOrder(ctx) {
  const order = findOrder(ctx, ctx.params[0]);
  const back = `/orders/${enc(order.po)}`;
  assertFresh(ctx, 'order', order.po, order, back);
  const { ledger } = ctx.data;
  const payments = ledger.payments.filter((p) => p.allocations.some((a) => a.type === 'order' && a.target === order.po)).map((p) => p.id);
  const shipments = ledger.shipments.filter((s) => s.items.some((i) => i.po === order.po)).map((s) => s.id);
  if (payments.length || shipments.length) {
    const what = [payments.length && `payment${payments.length === 1 ? '' : 's'} ${payments.join(', ')}`, shipments.length && `shipment${shipments.length === 1 ? '' : 's'} ${shipments.join(', ')}`].filter(Boolean).join(' and ');
    throw Object.assign(new HttpError(400, `${order.po} can't be deleted while ${what} still point${payments.length + shipments.length === 1 ? 's' : ''} at it. Delete or change ${payments.length + shipments.length === 1 ? 'it' : 'those'} first.`), { back });
  }
  for (const inv of order.invoices || []) for (const a of listAttachments(ctx.db, 'invoice', inv.id)) removeAttachment(ctx.db, a.id, { actor: ctx.actor });
  for (const a of listAttachments(ctx.db, 'order', order.po)) removeAttachment(ctx.db, a.id, { actor: ctx.actor });
  for (const t of tasksForPo(ctx.db, order.po)) saveTask(ctx.db, { ...t, po: null }, { actor: ctx.actor, action: 'edit' });
  deleteRecord(ctx.db, 'order', order.po, { actor: ctx.actor });
  return { redirect: `/orders?ok=${enc(`${order.po} deleted.`)}` };
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
  order.writeOffs = [...(order.writeOffs || []), compact({ product, qty, reason: required(text(f, 'reason'), 'Reason'), date: new Date().toISOString().slice(0, 10) })];
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  return { redirect: `/orders/${enc(order.po)}?ok=Written+off.` };
}
