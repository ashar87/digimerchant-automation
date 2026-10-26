import { html } from '../html.js';
import { ACCOUNTS, buildFeed, toXlsx, PAGE_COLUMNS } from '../../sellerboard/feed.js';
import { readSellerboardExport, saveCatalog, loadCatalog } from '../../sellerboard/catalog.js';
import { publishFeed } from '../../sellerboard/publish.js';
import { sellerboardTasks, sellerboardTask, markSellerboardDone } from '../../sellerboard/tasks.js';
import { fmtRmb, D } from '../../landing/money.js';
import { HttpError } from '../errors.js';
import { enc } from './common.js';
import { lastSync } from './amazon.js';

function sheetStatus(ctx, account) {
  if (!ctx.sheets?.[account]) return html`<span class="muted small">Google Sheet not set up: download the file and import it in Sellerboard by hand.</span>`;
  const last = lastSync(ctx.db, `sellerboard:${account}`);
  if (!last) return 'Google Sheet not written yet.';
  return html`Google Sheet last written ${last.at.slice(0, 16).replace('T', ' ')} ${last.ok ? `✓ (${last.summary.rows} rows)` : html`<span class="badge bad">failed: ${(last.summary.errors || []).join('; ')}</span>`}`;
}

const money = (account, cost) => `${ACCOUNTS[account].currency === 'USD' ? '$' : '£'}${cost}`;
const same = (a, b) => a && b && a.date === b.date && a.units === b.units && a.cost === b.cost;

/** What Sellerboard has that differs from the dashboard: "£3.57, 2,000 units". */
function sellerboardHas(t) {
  const was = [];
  if (t.entered.date !== t.target.date) was.push(`date ${t.entered.date}`);
  if (t.entered.cost !== t.target.cost) was.push(money(t.account, t.entered.cost));
  if (t.entered.units !== t.target.units) was.push(`${fmtRmb(D(t.entered.units))} units`);
  return was.join(', ');
}

/** The figures to type in, and for an update what Sellerboard has now. */
export function sellerboardDetail(t) {
  const now = `${ACCOUNTS[t.account].label} account · Batch date ${t.target.date} · ${fmtRmb(D(t.target.units))} units · ${money(t.account, t.target.cost)}`;
  return t.state === 'update' && t.entered ? `${now} (Sellerboard has ${sellerboardHas(t)})` : now;
}

export function doneForm(t, back) {
  return html`<form class="inline" method="post" action="/sellerboard/done"><input type="hidden" name="shipment" value="${t.shipment}"><input type="hidden" name="product" value="${t.product}"><input type="hidden" name="back" value="${back}"><button title="It’s in Sellerboard with these figures">Done</button></form>`;
}

function taskTable(tasks, { done = false } = {}) {
  return html`<div class="card scroll"><table><thead><tr><th>SKU</th><th>Marketplace</th><th>Shipment</th><th>Batch date</th><th class="n">Units</th><th class="n">Cost</th><th>${done ? 'Added' : ''}</th></tr></thead><tbody>
${tasks.map((t) => {
  const behind = done && !same(t.entered, t.target);
  return html`<tr><td>${t.sku}</td><td>${t.marketplace}</td><td><a href="/shipments/${enc(t.shipment)}">${t.shipment}</a></td><td>${t.target.date}</td><td class="n">${fmtRmb(D(t.target.units))}</td><td class="n">${money(t.account, t.target.cost)}</td>
<td class="small">${done
    ? html`${t.done_at ? `${t.done_at.slice(0, 10)} by ${t.done_by}` : ''}${behind ? html`<div class="muted">Sellerboard has ${sellerboardHas(t)}. You’ll be asked to change it once Amazon closes the shipment.</div>` : ''}`
    : html`${t.state === 'update' && t.entered ? html`<span class="muted">Sellerboard has ${sellerboardHas(t)}</span> ` : ''}${doneForm(t, '/sellerboard')}`}</td></tr>`;
})}
</tbody></table></div>`;
}

function catalogForm(account, c) {
  const a = ACCOUNTS[account];
  return html`<form method="post" action="/sellerboard/catalog" enctype="multipart/form-data" class="small">
<input type="hidden" name="account" value="${account}">
${c ? html`Sellerboard’s product list: ${c.count} rows, uploaded ${c.uploadedAt.slice(0, 10)} by ${c.uploadedBy}.` : html`<b>Upload Sellerboard’s product list first.</b>`}
<label for="catalog-${account}" style="display:inline;margin-left:8px">${c ? 'Replace with a fresh export:' : `${a.label} account, Products → Export:`}</label>
<input id="catalog-${account}" type="file" name="file" required accept=".xlsx"> <button class="ghost">Upload</button></form>`;
}

export function sellerboardPage(ctx) {
  const { ledger, result } = ctx.data;
  const catalog = loadCatalog(ctx.db);
  const feed = buildFeed(ledger, result, { catalog });
  const all = buildFeed(ledger, result, { includeManual: true, catalog });
  const anySheet = Object.keys(ctx.sheets || {}).length > 0;
  const tasks = sellerboardTasks(ctx.db);
  const toAdd = tasks.filter((t) => t.state === 'add');
  const toUpdate = tasks.filter((t) => t.state === 'update');
  const done = tasks.filter((t) => t.state === 'done');
  const body = html`
<h1>Sellerboard</h1>
<p class="sub">Sellerboard can’t import costs by itself, so batches are typed in by hand: in Sellerboard, the product’s cost of goods, by batch. When Amazon starts receiving a shipment you get a WhatsApp message with the figures; once it’s in, reply Y or press Done here. If the cost, units or date change by the time Amazon closes the shipment, you’re asked to update it.</p>

<h2>To add (${toAdd.length})</h2>
${toAdd.length ? taskTable(toAdd) : html`<p class="muted">Nothing to add.</p>`}
<h2>To update (${toUpdate.length})</h2>
${toUpdate.length ? taskTable(toUpdate) : html`<p class="muted">Nothing to update.</p>`}
<details class="card"${done.length ? '' : ' open'}><summary>In Sellerboard (${done.length})</summary>
${done.length ? taskTable(done, { done: true }) : html`<p class="muted small">None yet.</p>`}
</details>

<details class="card"><summary>Import file instead of typing (optional)</summary>
<p class="small">One row per product per shipment for each Sellerboard account: UK + DE in GBP, the US in USD. Useful when several batches land at once. Importing doesn’t tick them off here: press Done for each.</p>
${anySheet ? html`<form method="post" action="/sellerboard/publish"><button class="ghost">Write the Google Sheets now</button></form>` : ''}
${Object.entries(ACCOUNTS).map(([account, a]) => {
  const rows = feed.rows.filter((r) => r.account === account);
  return html`<h3>${a.label} account (${a.currency}): ${rows.length} row${rows.length === 1 ? '' : 's'}</h3>
<div>${catalogForm(account, catalog[account])}</div>
<p><a class="button" href="/sellerboard.xlsx?account=${account}">Download ${a.label} import file</a> ${sheetStatus(ctx, account)}</p>
${rows.length
  ? html`<div class="scroll"><table><thead><tr>${PAGE_COLUMNS.map((c) => html`<th class="${['quantity', 'cost'].includes(c.key) ? 'n' : ''}">${c.header}</th>`)}</tr></thead><tbody>
${rows.map((r) => html`<tr>${PAGE_COLUMNS.map((c) => html`<td class="${['quantity', 'cost'].includes(c.key) ? 'n' : ''}">${r[c.key]}</td>`)}</tr>`)}
</tbody></table></div>`
  : html`<p class="muted">Nothing yet.</p>`}`;
})}
<p class="muted small">In Sellerboard: <b>Products → Import</b>, accounting method <b>by batch</b>, batch date = CostPeriodStartDate. An import adds each batch beside the ones already there; importing the same batch again doesn’t add it twice. Costs go in to 2 decimals (Sellerboard won’t take more); the dashboard keeps 4. Every column apart from the batch date, cost, marketplace and units is copied from Sellerboard’s own product list, so its VAT, EAN and other settings are left as they are. The files hold your unit costs; keep them private.</p>
</details>

<details class="card"><summary>Comparing with what's in Sellerboard (${all.rows.length} batch rows, including those typed in by hand)</summary>
${Object.entries(ACCOUNTS).map(([account, a]) => {
  const ids = [...new Set(all.rows.filter((r) => r.account === account).map((r) => r.shipment))];
  return html`<h3>${a.label}</h3>${ids.length
    ? html`<ul class="docs small">${ids.map((id) => html`<li><a href="/sellerboard.xlsx?account=${account}&amp;all=1&amp;shipment=${enc(id)}">${id}</a> <span class="muted">${all.rows.filter((r) => r.shipment === id).map((r) => `${r.sku || r.asin} ${r.exactCost} ${r.currency}`).join(' · ')}</span></li>`)}</ul>
<p class="small"><a href="/sellerboard.xlsx?account=${account}&amp;all=1">Download all ${a.label} rows</a></p>`
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

export async function sellerboardXlsx(ctx) {
  const { ledger, result } = ctx.data;
  // Each Sellerboard account gets its own file, so the account is always named.
  const account = ctx.url.searchParams.get('account');
  if (!ACCOUNTS[account]) throw new HttpError(400, `Say which Sellerboard account: ${Object.keys(ACCOUNTS).join(' or ')}.`);
  // ?all=1 adds the batches typed into Sellerboard by hand (to compare, or to test the import);
  // ?shipment=FBA… narrows the file to one shipment, so a test touches as little as possible.
  const all = ctx.url.searchParams.get('all') === '1';
  const shipment = ctx.url.searchParams.get('shipment') || null;
  const rows = buildFeed(ledger, result, { includeManual: all, shipment, account, catalog: loadCatalog(ctx.db) }).rows;
  const name = `sellerboard-cogs-${account}-${shipment || (all ? 'all' : 'new')}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  return { body: await toXlsx(rows), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'Content-Disposition': `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"` } };
}

export async function uploadSellerboardCatalog(ctx) {
  const account = ctx.form.get('account');
  if (!ACCOUNTS[account]) throw new HttpError(400, 'Which Sellerboard account is this export from?');
  const file = ctx.files.find((f) => f.name === 'file');
  if (!file?.data?.length) throw new HttpError(400, 'Choose the export file to upload');
  let read;
  try {
    read = await readSellerboardExport(file.data);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  if (read.account && read.account !== account) throw new HttpError(400, `That export is from the ${ACCOUNTS[read.account].label} account, not ${ACCOUNTS[account].label}.`);
  saveCatalog(ctx.db, { account, rows: read.rows, filename: file.filename, actor: ctx.actor });
  return { redirect: `/sellerboard?ok=${enc(`${ACCOUNTS[account].label} product list updated: ${read.rows.length} rows.`)}` };
}

export function sellerboardDone(ctx) {
  const shipment = String(ctx.form.get('shipment') || '');
  const product = String(ctx.form.get('product') || '');
  const asked = String(ctx.form.get('back') || '');
  const back = asked.startsWith('/') && !asked.startsWith('//') ? asked : '/sellerboard';
  const t = sellerboardTask(ctx.db, shipment, product);
  if (!t) throw new HttpError(400, `${shipment} isn’t on the Sellerboard list.`);
  if (t.state === 'done') return { redirect: `${back}${back.includes('?') ? '&' : '?'}ok=${enc(`${t.sku} ${t.shipment} was already marked as in Sellerboard.`)}` };
  markSellerboardDone(ctx.db, { shipment, product, actor: ctx.actor });
  return { redirect: `${back}${back.includes('?') ? '&' : '?'}ok=${enc(`${t.sku} ${t.shipment}: marked as in Sellerboard (${money(t.account, t.target.cost)}, ${fmtRmb(D(t.target.units))} units).`)}` };
}

export async function publishSellerboard(ctx) {
  if (!Object.keys(ctx.sheets || {}).length) throw new HttpError(400, 'The Google Sheets aren’t set up yet.');
  const r = await publishFeed({ db: ctx.db, writers: ctx.sheets });
  const said = r.results.map((x) => (x.ok ? `${ACCOUNTS[x.account].label} sheet updated: ${x.rows} row(s).` : `${ACCOUNTS[x.account].label} sheet failed: ${x.error}`));
  return { redirect: `/sellerboard?ok=${enc(said.join(' '))}` };
}
