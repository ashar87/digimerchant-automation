import { html } from '../html.js';
import { getSetting } from '../../landing/store.js';
import { refHref, enc } from './common.js';
import { versionField } from '../versions.js';
import { awaitingReply } from '../../notify/outbox.js';
import { unmappedSkus, lastSync } from './amazon.js';
import { pendingDrafts } from '../../invoices/intake.js';
import { rateLookups } from '../../quickbooks/rates.js';
import { unrecordedTransfers } from '../../wise/import.js';
import { inboxTaskItems } from './tasks.js';

/**
 * Everything that needs a person, most urgent first. Things that only need
 * waiting for (Amazon still counting) stay out of the list.
 */
export function inboxItems(ctx) {
  const { ledger, result } = ctx.data;
  const items = [];

  for (const i of result.issues.filter((x) => x.severity === 'error')) {
    items.push({ tone: 'error', title: i.message, href: refHref(ledger, i.ref), count: true });
  }
  for (const i of result.issues.filter((x) => x.severity === 'warning')) {
    items.push({ tone: 'warning', title: i.message, href: refHref(ledger, i.ref), count: true });
  }
  items.push(...inboxTaskItems(ctx.db));
  const sync = lastSync(ctx.db);
  if (sync && !sync.ok) items.push({ tone: 'error', title: `The last Amazon check failed: ${(sync.summary.errors || []).join('; ')}`, href: '/shipments', count: true });
  for (const card of awaitingReply(ctx.db)) {
    items.push({ tone: 'warning', title: card.text.split('\n')[0].replace(/^\S+\s/, ''), detail: card.text.split('\n').slice(1, -1).join(' · '), href: card.payload?.shipment ? `/shipments/${enc(card.payload.shipment)}` : '/messages', card: card.id, count: true });
  }
  for (const d of pendingDrafts(ctx.db)) {
    const problems = (d.reading.checks || []).filter((c) => c.severity !== 'ok').length;
    items.push({ tone: 'warning', title: `Invoice to check: ${d.filename || `invoice ${d.id}`}${d.po ? ` for ${d.po}` : ''}`, detail: `${d.source === 'whatsapp' ? 'Forwarded on WhatsApp' : `Uploaded by ${d.created_by}`} · ${problems ? `${problems} thing(s) to look at` : 'arithmetic adds up'}`, href: `/invoices/drafts/${d.id}`, count: true });
  }
  for (const l of rateLookups(ctx.db)) {
    items.push({ tone: l.status === 'failed' ? 'error' : 'warning', title: `QB rate ${l.status === 'failed' ? 'lookup failed' : 'pending'} for payment ${l.payment_id} (${l.currency}, ${l.date}): ${l.message}`, href: `/payments/${enc(l.payment_id)}`, count: true });
  }
  const wise = unrecordedTransfers(ctx.db).length;
  if (wise) items.push({ tone: 'warning', title: `${wise} Wise transfer${wise === 1 ? '' : 's'} to record as payments`, href: '/wise', count: true });
  for (const u of unmappedSkus(ctx.db)) {
    items.push({ tone: 'warning', title: `Amazon lists SKU ${u.sku}${u.fnsku ? ` (${u.fnsku})` : ''} on ${u.shipment_id}, but it isn’t in the product list. Add the SKU to the right product.`, href: '/products', count: true });
  }
  for (const o of ledger.orders.filter((x) => x.review === 'needs_review')) {
    items.push({
      tone: 'warning',
      title: `Imported order to check: ${o.po} · ${o.supplier} · ${o.marketplace}`,
      detail: o.source ? `From the sheet: ${o.source}` : null,
      href: `/orders/${enc(o.po)}`,
      review: o.po,
      order: o,
      count: true,
    });
  }
  if (!getSetting(ctx.db, 'cutover_date')) {
    items.push({ tone: 'info', title: 'No cutover date yet. Agree one with Atif; from then on new orders go in here, not the sheet.', href: '/settings', count: false });
  }
  return items;
}

export function inboxPage(ctx) {
  const { ledger, result } = ctx.data;
  const items = inboxItems(ctx);
  const needing = items.filter((i) => i.count);
  const notes = result.issues.filter((i) => i.severity === 'info');
  const waiting = result.shipments.filter((s) => !s.closed);

  const body = html`
<h1>${needing.length ? `${needing.length} thing${needing.length === 1 ? '' : 's'} need${needing.length === 1 ? 's' : ''} you` : 'Nothing needs you'}</h1>
<p class="sub">Most urgent first.</p>
${items.length
  ? html`<div class="card"><ul class="items">${items.map(
      (i) => html`<li><span class="sev ${i.tone}">${i.tone === 'error' ? '✗' : i.tone === 'warning' ? '!' : 'i'}</span>
      <div style="flex:1">${i.href ? html`<a href="${i.href}">${i.title}</a>` : i.title}${i.detail ? html`<div class="muted small">${i.detail}</div>` : ''}</div>
      ${i.review ? html`<form class="inline" method="post" action="/orders/${enc(i.review)}/review"><input type="hidden" name="back" value="/">${versionField(i.order)}<button class="ghost">Mark checked</button></form>` : ''}
      ${i.card ? html`<form class="inline" method="post" action="/cards/${i.card}/reply"><button name="reply" value="Y">Link</button> <button class="ghost" name="reply" value="N">Not this</button></form>` : ''}</li>`
    )}</ul></div>`
  : ''}
${waiting.length
  ? html`<p class="muted small">Waiting on Amazon, nothing to do: ${waiting.map((s, i) => html`${i ? ', ' : ''}<a href="/shipments/${enc(s.id)}">${s.id}</a>`)}.</p>`
  : ''}
${notes.length
  ? html`<details><summary>${notes.length} note${notes.length === 1 ? '' : 's'}</summary><ul class="small">${notes.map((n) => html`<li>${n.message}</li>`)}</ul></details>`
  : ''}`;
  return { title: 'Inbox', body };
}
