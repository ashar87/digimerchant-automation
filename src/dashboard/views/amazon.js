import { html } from '../html.js';
import { syncAmazon } from '../../amazon/sync.js';
import { applyCardReply } from '../../amazon/links.js';
import { recent } from '../../notify/outbox.js';
import { HttpError } from '../errors.js';
import { enc } from './common.js';

export function lastSync(db, kind = 'amazon') {
  const row = db.prepare('SELECT at, ok, summary FROM sync_runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind);
  return row ? { at: row.at, ok: !!row.ok, summary: JSON.parse(row.summary || '{}') } : null;
}

export function unmappedSkus(db) {
  return db.prepare('SELECT * FROM amazon_unmapped ORDER BY seen_at DESC, shipment_id').all();
}

/** The Amazon line on the Shipments page: when it last ran, and a button to run it now. */
export function amazonPanel(ctx) {
  const last = lastSync(ctx.db);
  if (!ctx.spapi) {
    return html`<p class="notice">Amazon isn’t connected yet, so statuses and counts are entered by hand. Once the developer registration is approved and the keys are on the server, this page fills itself each morning.</p>`;
  }
  return html`<form class="card" method="post" action="/amazon/sync">
${last ? html`Last checked with Amazon ${last.at.slice(0, 16).replace('T', ' ')} ${last.ok ? '✓' : html`<span class="badge bad">failed: ${(last.summary.errors || []).join('; ')}</span>`}` : 'Not checked with Amazon yet.'}
<button class="ghost" style="margin-left:12px">Check now</button></form>`;
}

export async function runAmazonSync(ctx) {
  if (!ctx.spapi) throw new HttpError(400, 'Amazon isn’t connected yet.');
  const r = await syncAmazon({ db: ctx.db, client: ctx.spapi, actor: `amazon-sync (${ctx.actor})` });
  const msg = r.errors.length ? `Amazon check had problems: ${r.errors.join('; ')}` : `Checked ${r.checked} shipment(s): ${r.created.length} new, ${r.updated.length} updated, ${r.cards} card(s) queued.`;
  return { redirect: `/shipments?ok=${enc(msg)}` };
}

export async function replyToCard(ctx) {
  const id = Number(ctx.params[0]);
  const reply = ctx.form.get('reply');
  if (!['Y', 'N'].includes(reply)) throw new HttpError(400, 'Reply Y or N');
  const out = await applyCardReply(ctx.db, id, reply, { actor: ctx.actor, client: ctx.spapi });
  return { redirect: `/?ok=${enc(out.message)}` };
}

export function messagesPage(ctx) {
  const cards = recent(ctx.db, 60);
  const body = html`
<h1>Messages</h1>
<p class="sub">Cards for the WhatsApp self-chat. The WhatsApp listener sends them; until it’s connected to this queue, they wait here.</p>
${cards.length ? cards.map((c) => html`<div class="card"><div class="muted small">${c.created_at.slice(0, 16).replace('T', ' ')} · ${c.kind.replace(/_/g, ' ')} · ${c.sent_at ? `sent ${c.sent_at.slice(0, 16).replace('T', ' ')}` : 'not sent yet'}${c.reply ? ` · answered ${c.reply} by ${c.replied_by}` : c.needs_reply ? ' · waiting for Y/N' : ''}</div>
<pre style="white-space:pre-wrap;font:inherit;margin:6px 0 0">${c.text}</pre></div>`) : html`<p class="muted">Nothing yet.</p>`}`;
  return { title: 'Messages', body };
}
