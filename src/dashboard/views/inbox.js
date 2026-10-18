import { html } from '../html.js';
import { HttpError } from '../errors.js';
import { getSetting, setSetting } from '../../landing/store.js';
import { refHref, enc } from './common.js';
import { versionField } from '../versions.js';
import { awaitingReply } from '../../notify/outbox.js';
import { unmappedSkus, lastSync } from './amazon.js';
import { pendingDrafts } from '../../invoices/intake.js';
import { pendingBillDrafts } from '../../bills/intake.js';
import { rateLookups } from '../../quickbooks/rates.js';
import { unrecordedTransfers } from '../../wise/import.js';
import { inboxTaskItems } from './tasks.js';
import { readHealth, healthItems } from '../../health.js';
import { lastBackup, backupItems } from '../../backup/run.js';
import { config } from '../../config.js';

/**
 * Everything that needs a person, most urgent first. Things that only need
 * waiting for (Amazon still counting) stay out of the list.
 */
export function inboxItems(ctx) {
  const { ledger, result } = ctx.data;
  const items = [];

  // The WhatsApp listener first: when it's down, nothing else reaches your phone.
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: config.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  items.push(...healthItems(readHealth(ctx.db), { pinned: config.waWebVersion, pinExpires: config.waWebVersionExpires, when }));
  // Only where backups are meant to run (the server sets BACKUP_PASSPHRASE).
  items.push(...backupItems(lastBackup(ctx.db), { when, configured: !!config.backup.passphrase }));

  for (const i of result.issues.filter((x) => x.severity === 'error')) {
    items.push({ tone: 'error', title: i.message, href: refHref(ledger, i.ref), count: true });
  }
  const dismissed = new Set(dismissedChecks(ctx.db).map((d) => d.message));
  for (const i of result.issues.filter((x) => x.severity === 'warning' && !dismissed.has(x.message))) {
    items.push({ tone: 'warning', title: i.message, href: refHref(ledger, i.ref), dismiss: i.message, count: true });
  }
  items.push(...inboxTaskItems(ctx.db));
  const sync = lastSync(ctx.db);
  if (sync && !sync.ok) items.push({ tone: 'error', title: `The last Amazon check failed: ${(sync.summary.errors || []).join('; ')}`, href: '/shipments', count: true });
  for (const card of awaitingReply(ctx.db)) {
    const shipment = card.payload?.shipment ? ledger.shipments.find((s) => s.id === card.payload.shipment) : null;
    items.push({ tone: 'warning', title: card.text.split('\n')[0].replace(/^\S+\s/, ''), detail: card.text.split('\n').slice(1, -1).join(' · '), href: card.payload?.shipment ? `/shipments/${enc(card.payload.shipment)}` : '/messages', card: card.id, shipment: shipment && !shipment.items.some((i) => i.po) ? shipment : null, count: true });
  }
  for (const d of pendingDrafts(ctx.db)) {
    const problems = (d.reading.checks || []).filter((c) => c.severity !== 'ok').length;
    items.push({ tone: 'warning', title: `Invoice to check: ${d.filename || `invoice ${d.id}`}${d.po ? ` for ${d.po}` : ''}`, detail: `${d.source === 'whatsapp' ? 'Forwarded on WhatsApp' : `Uploaded by ${d.created_by}`} · ${problems ? `${problems} thing(s) to look at` : 'arithmetic adds up'}`, href: `/invoices/drafts/${d.id}`, count: true });
  }
  for (const d of pendingBillDrafts(ctx.db)) {
    const problems = (d.reading.checks || []).filter((c) => c.severity !== 'ok').length;
    items.push({ tone: 'warning', title: `Courier bill to check: ${d.filename || `bill ${d.id}`}`, detail: `Uploaded by ${d.created_by} · ${problems ? `${problems} thing(s) to look at` : 'arithmetic adds up'}`, href: `/bills/drafts/${d.id}`, count: true });
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

/* ---------- dismissing a check you've looked at ---------- */

// Warnings someone has looked at and decided don't matter (a few RMB of rounding, a
// difference not worth chasing). Kept by exact wording: if the figures change, it's back.
const DISMISSED = 'dismissed_checks';

export function dismissedChecks(db) {
  try {
    return JSON.parse(getSetting(db, DISMISSED) || '[]');
  } catch {
    return [];
  }
}

function saveDismissed(ctx, list) {
  // Keep only what's still being raised, so the list doesn't grow forever.
  const current = new Set(ctx.data.result.issues.map((i) => i.message));
  setSetting(ctx.db, DISMISSED, JSON.stringify(list.filter((d) => current.has(d.message))), { actor: ctx.actor });
}

export function dismissCheck(ctx) {
  const message = String(ctx.form.get('message') || '');
  if (!ctx.data.result.issues.some((i) => i.severity === 'warning' && i.message === message)) throw new HttpError(400, 'That check is no longer raised, or can’t be dismissed.');
  saveDismissed(ctx, [...dismissedChecks(ctx.db).filter((d) => d.message !== message), { message, by: ctx.actor, at: new Date().toISOString() }]);
  return { redirect: '/?ok=Dismissed.+It+comes+back+if+the+figures+change.' };
}

export function restoreCheck(ctx) {
  const message = String(ctx.form.get('message') || '');
  saveDismissed(ctx, dismissedChecks(ctx.db).filter((d) => d.message !== message));
  return { redirect: '/?ok=Back+in+the+Inbox.' };
}

export function inboxPage(ctx) {
  const { ledger, result } = ctx.data;
  const items = inboxItems(ctx);
  const needing = items.filter((i) => i.count);
  const notes = result.issues.filter((i) => i.severity === 'info');
  const waiting = result.shipments.filter((s) => !s.closed);
  const current = new Set(result.issues.map((i) => i.message));
  const dismissed = dismissedChecks(ctx.db).filter((d) => current.has(d.message));

  const body = html`
<h1>${needing.length ? `${needing.length} thing${needing.length === 1 ? '' : 's'} need${needing.length === 1 ? 's' : ''} you` : 'Nothing needs you'}</h1>
<p class="sub">Most urgent first.</p>
${items.length
  ? html`<div class="card"><ul class="items">${items.map(
      (i) => html`<li><span class="sev ${i.tone}">${i.tone === 'error' ? '✗' : i.tone === 'warning' ? '!' : 'i'}</span>
      <div style="flex:1">${i.href ? html`<a href="${i.href}">${i.title}</a>` : i.title}${i.detail ? html`<div class="muted small">${i.detail}</div>` : ''}</div>
      ${i.review ? html`<form class="inline" method="post" action="/orders/${enc(i.review)}/review"><input type="hidden" name="back" value="/">${versionField(i.order)}<button class="ghost">Mark checked</button></form>` : ''}
      ${i.card ? html`<form class="inline" method="post" action="/cards/${i.card}/reply"><button name="reply" value="Y">Link</button> <button class="ghost" name="reply" value="N">Not this</button></form>` : ''}
      ${i.dismiss ? html`<form class="inline" method="post" action="/inbox/dismiss"><input type="hidden" name="message" value="${i.dismiss}"><button class="ghost" title="Looked at it and it doesn't matter. It comes back if the figures change.">Dismiss</button></form>` : ''}
      ${i.shipment ? html`<form class="inline" method="post" action="/shipments/${enc(i.shipment.id)}/ignore"><input type="hidden" name="back" value="/">${versionField(i.shipment)}<button class="ghost" title="Old shipment with no PO, or returned stock: remove it and skip it from now on">Ignore</button></form>` : ''}</li>`
    )}</ul></div>`
  : ''}
${waiting.length
  ? html`<p class="muted small">Waiting on Amazon, nothing to do: ${waiting.map((s, i) => html`${i ? ', ' : ''}<a href="/shipments/${enc(s.id)}">${s.id}</a>`)}.</p>`
  : ''}
${dismissed.length
  ? html`<details class="small"><summary>${dismissed.length} dismissed</summary><ul class="items">${dismissed.map(
      (d) => html`<li><div style="flex:1">${d.message}<div class="muted">Dismissed by ${d.by}, ${new Date(d.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</div></div>
      <form class="inline" method="post" action="/inbox/restore"><input type="hidden" name="message" value="${d.message}"><button class="ghost">Put back</button></form></li>`
    )}</ul></details>`
  : ''}
${notes.length
  ? html`<details><summary>${notes.length} note${notes.length === 1 ? '' : 's'}</summary><ul class="small">${notes.map((n) => html`<li>${n.message}</li>`)}</ul></details>`
  : ''}`;
  return { title: 'Inbox', body };
}
