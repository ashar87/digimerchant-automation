import { html } from '../html.js';
import { getSetting } from '../../landing/store.js';
import { refHref, enc } from './common.js';

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
  for (const o of ledger.orders.filter((x) => x.review === 'needs_review')) {
    items.push({
      tone: 'warning',
      title: `Imported order to check: ${o.po} · ${o.supplier} · ${o.marketplace}`,
      detail: o.source ? `From the sheet: ${o.source}` : null,
      href: `/orders/${enc(o.po)}`,
      review: o.po,
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
      ${i.review ? html`<form class="inline" method="post" action="/orders/${enc(i.review)}/review"><input type="hidden" name="back" value="/"><button class="ghost">Mark checked</button></form>` : ''}</li>`
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
