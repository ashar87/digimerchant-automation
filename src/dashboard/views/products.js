import { html, select } from '../html.js';
import { saveLedger, deleteRecord } from '../../landing/store.js';
import { text, required, compact, list } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { MARKETPLACES, enc } from './common.js';

export function productsPage(ctx) {
  const { ledger } = ctx.data;
  const body = html`
<h1>Products</h1>
<p class="sub">One entry per product per marketplace, with every name suppliers and old tabs use for it.</p>
<div class="card scroll"><table>
<thead><tr><th>ID</th><th>Code</th><th>Mkt</th><th>Name</th><th>SKU</th><th>ASIN</th><th>FNSKU</th><th>Also called</th></tr></thead>
<tbody>${ledger.products.map((p) => html`<tr><td><a href="/products/${enc(p.id)}">${p.id}</a></td><td>${p.code}</td><td>${p.marketplace}</td><td>${p.name || ''}</td>
<td>${p.sku || ''}</td><td>${p.asin || ''}</td><td>${p.fnsku || ''}</td><td class="small">${(p.aliases || []).join(', ')}</td></tr>`)}
</tbody></table></div>
<h2>Add a product</h2>
${productForm(null)}`;
  return { title: 'Products', body };
}

function productForm(p) {
  return html`<form class="card" method="post" action="/products${p ? `/${enc(p.id)}` : ''}"><div class="grid">
<div><label>Code (required)</label><input name="code" value="${p?.code || ''}" required placeholder="EGLS10"></div>
<div><label>Marketplace</label>${select('marketplace', MARKETPLACES, p?.marketplace || 'UK', { attrs: p ? 'disabled' : '' })}</div>
<div><label>Name</label><input name="name" value="${p?.name || ''}"></div>
<div><label>Seller SKU</label><input name="sku" value="${p?.sku || ''}"></div>
<div><label>ASIN</label><input name="asin" value="${p?.asin || ''}"></div>
<div><label>FNSKU</label><input name="fnsku" value="${p?.fnsku || ''}"></div>
</div>
<label>Also called (comma-separated)</label><input name="aliases" value="${(p?.aliases || []).join(', ')}" style="width:100%">
<p><button>${p ? 'Save product' : 'Add product'}</button></p></form>`;
}

export function productPage(ctx) {
  const p = ctx.data.ledger.products.find((x) => x.id === ctx.params[0]);
  if (!p) throw notFound(`Product ${ctx.params[0]}`);
  return {
    title: p.id,
    body: html`<p class="muted small"><a href="/products">Products</a></p><h1>${p.id}</h1>${productForm(p)}
<form method="post" action="/products/${enc(p.id)}/delete"><button class="danger">Delete product</button></form>`,
  };
}

export function saveProduct(ctx) {
  const { ledger } = ctx.data;
  const f = ctx.form;
  const existing = ctx.params[0] ? ledger.products.find((x) => x.id === ctx.params[0]) : null;
  if (ctx.params[0] && !existing) throw notFound(`Product ${ctx.params[0]}`);
  const code = required(text(f, 'code'), 'Code').toUpperCase();
  const marketplace = existing?.marketplace || text(f, 'marketplace');
  if (!MARKETPLACES.includes(marketplace)) throw new HttpError(400, 'Choose UK, DE or US');
  const id = existing?.id || `${code}-${marketplace}`;
  if (!existing && ledger.products.some((p) => p.id === id)) throw new HttpError(400, `${id} already exists`);
  const product = compact({ id, code, marketplace, name: text(f, 'name'), sku: text(f, 'sku'), asin: text(f, 'asin'), fnsku: text(f, 'fnsku') });
  const aliases = list(f.get('aliases'));
  if (aliases.length) product.aliases = aliases;
  saveLedger(ctx.db, { products: [product] }, { actor: ctx.actor });
  return { redirect: `/products?ok=${enc(`${id} saved.`)}` };
}

export function deleteProduct(ctx) {
  const { ledger } = ctx.data;
  const id = ctx.params[0];
  const used = ledger.orders.some((o) => o.invoices.some((i) => i.lines.some((l) => l.product === id))) || ledger.shipments.some((s) => s.items.some((i) => i.product === id));
  if (used) throw new HttpError(400, `${id} is on an invoice or shipment, so it can't be deleted`);
  if (!deleteRecord(ctx.db, 'product', id, { actor: ctx.actor })) throw notFound(`Product ${id}`);
  return { redirect: '/products?ok=Product+deleted.' };
}
