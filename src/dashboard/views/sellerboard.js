import { html } from '../html.js';
import { ACCOUNTS, buildFeed, toCsv, PAGE_COLUMNS } from '../../sellerboard/feed.js';
import { publishFeed } from '../../sellerboard/publish.js';
import { HttpError } from '../errors.js';
import { enc } from './common.js';
import { lastSync } from './amazon.js';

// The account is in its own column heading, so it's left out of each table.
const COLUMNS = PAGE_COLUMNS.filter((c) => c.key !== 'currency');

function sheetStatus(ctx, account) {
  if (!ctx.sheets?.[account]) return html`<span class="muted small">Google Sheet not set up: download the CSV and upload it in Sellerboard by hand.</span>`;
  const last = lastSync(ctx.db, `sellerboard:${account}`);
  if (!last) return 'Google Sheet not written yet.';
  return html`Google Sheet last written ${last.at.slice(0, 16).replace('T', ' ')} ${last.ok ? `✓ (${last.summary.rows} rows)` : html`<span class="badge bad">failed: ${(last.summary.errors || []).join('; ')}</span>`}`;
}

export function sellerboardPage(ctx) {
  const { ledger, result } = ctx.data;
  const feed = buildFeed(ledger, result);
  const all = buildFeed(ledger, result, { includeManual: true });
  const anySheet = Object.keys(ctx.sheets || {}).length > 0;
  const body = html`
<h1>Sellerboard</h1>
<p class="sub">One row per product per shipment, for each Sellerboard account: UK + DE in GBP, the US in USD. A shipment is added the day Amazon starts receiving it, and dated that day.</p>
${anySheet ? html`<form method="post" action="/sellerboard/publish"><button class="ghost">Write the Google Sheets now</button></form>` : ''}

${Object.entries(ACCOUNTS).map(([account, a]) => {
  const rows = feed.rows.filter((r) => r.account === account);
  return html`<h2>${a.label} account (${a.currency}): ${rows.length} row${rows.length === 1 ? '' : 's'}</h2>
<p><a class="button" href="/sellerboard.csv?account=${account}">Download ${a.label} CSV</a> ${sheetStatus(ctx, account)}</p>
${rows.length
  ? html`<div class="card scroll"><table><thead><tr>${COLUMNS.map((c) => html`<th>${c.header}</th>`)}</tr></thead><tbody>
${rows.map((r) => html`<tr>${COLUMNS.map((c) => html`<td class="${['quantity', 'cost'].includes(c.key) ? 'n' : ''}">${r[c.key]}</td>`)}</tr>`)}
</tbody></table></div>`
  : html`<p class="muted">Nothing yet.</p>`}`;
})}
<p class="muted small">The CSVs hold your unit costs; keep them private.</p>

<details class="card"><summary>Testing the import, or comparing with what's in Sellerboard (${all.rows.length} batch rows, including those typed in by hand)</summary>
<p class="small">Sellerboard: <b>Products → Import → By batch</b>, in the right account. Sellerboard support says an import adds a batch beside the ones already there and never replaces them. Still to check: importing the <b>same</b> batch a second time. Does it update that batch or add a duplicate? Try it with one shipment before connecting a sheet.</p>
${Object.entries(ACCOUNTS).map(([account, a]) => {
  const ids = [...new Set(all.rows.filter((r) => r.account === account).map((r) => r.shipment))];
  return html`<h3>${a.label}</h3>${ids.length
    ? html`<ul class="docs small">${ids.map((id) => html`<li><a href="/sellerboard.csv?account=${account}&amp;all=1&amp;shipment=${enc(id)}">${id}</a> <span class="muted">${all.rows.filter((r) => r.shipment === id).map((r) => `${r.sku || r.asin} ${r.cost} ${r.currency}`).join(' · ')}</span></li>`)}</ul>
<p class="small"><a href="/sellerboard.csv?account=${account}&amp;all=1">Download all ${a.label} rows</a></p>`
    : html`<p class="muted small">None.</p>`}`;
})}
</details>

<h2>Held back (${feed.held.length})</h2>
<div class="card scroll"><table><thead><tr><th>Batch</th><th>Why</th></tr></thead><tbody>
${feed.held.map((h) => html`<tr><td><a href="/costs/${enc(h.shipment)}/${enc(h.product)}">${h.code || h.product} ${h.marketplace} · ${h.shipment}</a></td><td class="small">${h.reason}</td></tr>`)}
</tbody></table></div>
<p class="muted small">Shipments whose cost was typed into Sellerboard by hand stay out of the feed, so it’s never counted twice. To hand one over, delete the hand-entered batch in Sellerboard, then untick “typed into Sellerboard by hand” on the shipment.</p>`;
  return { title: 'Sellerboard', body };
}

export function sellerboardCsv(ctx) {
  const { ledger, result } = ctx.data;
  // Each Sellerboard account gets its own file, so the account is always named.
  const account = ctx.url.searchParams.get('account');
  if (!ACCOUNTS[account]) throw new HttpError(400, `Say which Sellerboard account: ${Object.keys(ACCOUNTS).join(' or ')}.`);
  // ?all=1 adds the batches typed into Sellerboard by hand (to compare, or to test the import);
  // ?shipment=FBA… narrows the file to one shipment, so a test touches as little as possible.
  const all = ctx.url.searchParams.get('all') === '1';
  const shipment = ctx.url.searchParams.get('shipment') || null;
  const rows = buildFeed(ledger, result, { includeManual: all, shipment, account }).rows;
  const name = `sellerboard-cogs-${account}-${shipment || (all ? 'all' : 'new')}-${new Date().toISOString().slice(0, 10)}.csv`;
  return { text: toCsv(rows), type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"` } };
}

export async function publishSellerboard(ctx) {
  if (!Object.keys(ctx.sheets || {}).length) throw new HttpError(400, 'The Google Sheets aren’t set up yet.');
  const r = await publishFeed({ db: ctx.db, writers: ctx.sheets });
  const said = r.results.map((x) => (x.ok ? `${ACCOUNTS[x.account].label} sheet updated: ${x.rows} row(s).` : `${ACCOUNTS[x.account].label} sheet failed: ${x.error}`));
  return { redirect: `/sellerboard?ok=${enc(said.join(' '))}` };
}
