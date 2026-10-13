import { html } from '../html.js';
import { buildFeed, toCsv, COLUMNS } from '../../sellerboard/feed.js';
import { publishFeed } from '../../sellerboard/publish.js';
import { HttpError } from '../errors.js';
import { enc } from './common.js';
import { lastSync } from './amazon.js';

export function sellerboardPage(ctx) {
  const { ledger, result } = ctx.data;
  const feed = buildFeed(ledger, result);
  const last = lastSync(ctx.db, 'sellerboard');
  const body = html`
<h1>Sellerboard</h1>
<p class="sub">One row per product per shipment, read by Sellerboard’s automatic COGS import each day. A shipment is added the day Amazon starts receiving it, and dated that day. GBP for the UK and DE, USD for the US.</p>
${ctx.sheets
  ? html`<form class="card" method="post" action="/sellerboard/publish">${last ? html`Google Sheet last written ${last.at.slice(0, 16).replace('T', ' ')} ${last.ok ? `✓ (${last.summary.rows} rows)` : html`<span class="badge bad">failed: ${(last.summary.errors || []).join('; ')}</span>`}` : 'Google Sheet not written yet.'}
<button class="ghost" style="margin-left:12px">Write now</button></form>`
  : html`<p class="notice">The Google Sheet isn’t set up yet. Until it is, download the CSV below and upload it in Sellerboard by hand.</p>`}
<p><a class="button" href="/sellerboard.csv">Download CSV</a> <span class="muted small">It holds your unit costs; keep it private.</span></p>
${(() => {
  const all = buildFeed(ledger, result, { includeManual: true });
  const byShipment = [...new Set(all.rows.map((r) => r.shipment))];
  return html`<details class="card"><summary>Testing the import, or comparing with what's in Sellerboard (${all.rows.length} batch rows, including those typed in by hand)</summary>
<p class="small">Sellerboard: <b>Products → Import → By batch</b>. Try <b>one shipment</b> first and check what Sellerboard does with a batch it already has (adds a second one, or replaces it?) before uploading everything.</p>
<p><a href="/sellerboard.csv?all=1">Download all ${all.rows.length} rows</a></p>
<ul class="docs small">${byShipment.map((id) => html`<li><a href="/sellerboard.csv?all=1&amp;shipment=${enc(id)}">${id}</a> <span class="muted">${all.rows.filter((r) => r.shipment === id).map((r) => `${r.sku || r.asin} ${r.cost} ${r.currency}`).join(' · ')}</span></li>`)}</ul></details>`;
})()}

<h2>${feed.rows.length} row${feed.rows.length === 1 ? '' : 's'} for Sellerboard</h2>
${feed.rows.length
  ? html`<div class="card scroll"><table><thead><tr>${COLUMNS.map((c) => html`<th>${c.header}</th>`)}</tr></thead><tbody>
${feed.rows.map((r) => html`<tr>${COLUMNS.map((c) => html`<td class="${['quantity', 'cost'].includes(c.key) ? 'n' : ''}">${r[c.key]}</td>`)}</tr>`)}
</tbody></table></div>`
  : html`<p class="muted">Nothing yet.</p>`}

<h2>Held back (${feed.held.length})</h2>
<div class="card scroll"><table><thead><tr><th>Batch</th><th>Why</th></tr></thead><tbody>
${feed.held.map((h) => html`<tr><td><a href="/costs/${enc(h.shipment)}/${enc(h.product)}">${h.code || h.product} ${h.marketplace} · ${h.shipment}</a></td><td class="small">${h.reason}</td></tr>`)}
</tbody></table></div>
<p class="muted small">Shipments whose cost was typed into Sellerboard by hand stay out of the feed, so it’s never counted twice. To hand one over, delete the hand-entered batch in Sellerboard, then untick “typed into Sellerboard by hand” on the shipment.</p>`;
  return { title: 'Sellerboard', body };
}

export function sellerboardCsv(ctx) {
  const { ledger, result } = ctx.data;
  // ?all=1 adds the batches typed into Sellerboard by hand (to compare, or to test the import);
  // ?shipment=FBA… narrows the file to one shipment, so a test touches as little as possible.
  const all = ctx.url.searchParams.get('all') === '1';
  const shipment = ctx.url.searchParams.get('shipment') || null;
  const rows = buildFeed(ledger, result, { includeManual: all, shipment }).rows;
  const name = `sellerboard-cogs-${shipment || (all ? 'all' : 'new')}-${new Date().toISOString().slice(0, 10)}.csv`;
  return { text: toCsv(rows), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"` } };
}

export async function publishSellerboard(ctx) {
  if (!ctx.sheets) throw new HttpError(400, 'The Google Sheet isn’t set up yet.');
  const r = await publishFeed({ db: ctx.db, writer: ctx.sheets });
  return { redirect: `/sellerboard?ok=${enc(r.ok ? `Google Sheet updated: ${r.rows} row(s).` : `Writing the sheet failed: ${r.error}`)}` };
}
