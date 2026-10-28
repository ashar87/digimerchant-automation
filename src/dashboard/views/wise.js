import { html, money } from '../html.js';
import { saveTransfers, unrecordedTransfers } from '../../wise/import.js';
import { fillRates } from '../../quickbooks/rates.js';
import { HttpError } from '../errors.js';
import { enc } from './common.js';

export function wisePage(ctx) {
  const transfers = unrecordedTransfers(ctx.db);
  const body = html`
<p class="muted small"><a href="/payments">Payments</a></p>
<h1>From Wise</h1>
<p class="sub">Transfers that aren’t recorded as payments yet: the Wise payment messages you post in the supplier group on WhatsApp${ctx.wise ? ', and transfers read from Wise' : ''}. Recording one opens the payment form filled in from it; check what it paid for before saving.</p>
${ctx.wise ? html`<form class="card" method="post" action="/wise/fetch"><button class="ghost">Read the last 30 days from Wise</button></form>` : ''}
${transfers.length
  ? html`<div class="card scroll"><table><thead><tr><th>Date</th><th>Reference</th><th class="n">Sent</th><th class="n">Received</th><th></th></tr></thead><tbody>
${transfers.map((t) => html`<tr><td>${t.created.slice(0, 10)}</td><td>${t.reference || ''}</td><td class="n">${t.source_value ? html`${money(t.source_value, t.source_currency)} ${t.source_currency}` : html`<span class="muted small">GBP not known</span>`}</td><td class="n">${t.target_value ? `${t.target_value} ${t.target_currency}` : ''}</td>
<td><a class="button" href="/payments/new?wise=${enc(t.id)}">Record</a> <form class="inline" method="post" action="/wise/${enc(t.id)}/ignore"><button class="ghost">Not a supplier payment</button></form></td></tr>`)}
</tbody></table></div>`
  : html`<p class="muted">Nothing waiting.</p>`}`;
  return { title: 'From Wise', body };
}

export async function fetchWise(ctx) {
  if (!ctx.wise) throw new HttpError(400, 'Wise isn’t connected.');
  const to = new Date();
  const transfers = await ctx.wise.transfers({ from: new Date(to.getTime() - 30 * 86400_000).toISOString(), to: to.toISOString() });
  const n = saveTransfers(ctx.db, transfers);
  return { redirect: `/wise?ok=${enc(`Read ${n} transfer(s) from Wise.`)}` };
}

export function ignoreTransfer(ctx) {
  ctx.db.prepare('UPDATE wise_transfers SET ignored = 1 WHERE id = ?').run(ctx.params[0]);
  return { redirect: '/wise?ok=Hidden.' };
}

export async function lookupRate(ctx) {
  if (!ctx.qbo) throw new HttpError(400, 'QuickBooks isn’t connected.');
  const r = await fillRates({ db: ctx.db, qbo: ctx.qbo, actor: `qb-rates (${ctx.actor})`, only: ctx.params[0] });
  const msg = r.found.length ? `QB rate ${r.found[0].rate} filled in.` : r.pending.length ? 'QuickBooks has no rate for that day yet; it will be tried again.' : r.failed.length ? `QuickBooks lookup failed: ${r.failed[0].error}` : 'This payment doesn’t need a QB rate.';
  return { redirect: `/payments/${enc(ctx.params[0])}?ok=${enc(msg)}` };
}
