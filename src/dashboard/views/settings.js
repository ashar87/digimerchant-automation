import { html } from '../html.js';
import { getSetting, setSetting, nextPo, auditTrail } from '../../landing/store.js';
import { date, list } from '../forms.js';
import { readHealth } from '../../health.js';
import { lastBackup } from '../../backup/run.js';
import { config } from '../../config.js';
import { supplierList } from './common.js';

export function settingsPage(ctx) {
  const cutover = getSetting(ctx.db, 'cutover_date');
  const ignored = getSetting(ctx.db, 'amazon_ignored_shipments');
  const trail = auditTrail(ctx.db, { limit: 30 });
  const health = readHealth(ctx.db);
  const at = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const body = html`
<h1>Settings</h1>
<form class="card" method="post" action="/settings">
<div class="grid"><div><label>Cutover date</label><input type="date" name="cutover_date" value="${cutover || ''}"></div></div>
<p class="muted small">From this date new orders go into the system, no new tabs are created, and the sheet becomes read-only history. Agree it with Atif.</p>
<label for="ignored">Amazon shipments to ignore (FBA IDs, comma-separated)</label><input id="ignored" name="amazon_ignored_shipments" value="${ignored || ''}" style="width:100%">
<p class="muted small">Shipments of stock that isn't new, such as units Amazon returned to you that you sent back in. Their cost was counted when they first shipped, so the Amazon check skips these shipments.</p>
<button>Save</button></form>
<h2 id="suppliers">Suppliers</h2>
<form class="card" method="post" action="/settings/suppliers">
<label for="supplier-list">Supplier names, one per line</label><textarea id="supplier-list" name="suppliers" rows="${Math.max(4, supplierList(ctx).length + 1)}" style="width:100%">${supplierList(ctx).join('\n')}</textarea>
<p class="muted small">The choices in the Supplier dropdowns on orders and invoices. Taking a name off the list doesn't change orders that already use it.</p>
<button>Save suppliers</button></form>
<h2>Backups</h2>
${(() => {
  const b = lastBackup(ctx.db);
  if (!b) return html`<p class="muted small">No backup has run yet.</p>`;
  return html`<dl class="working small"><dt>Last backup</dt><dd>${at(b.at)} ${b.ok ? '✓' : html`<span class="badge bad">failed: ${b.error || ''}</span>`}</dd>
<dt>Copy kept</dt><dd>${b.offsite ? 'On this server and in Backblaze B2' : 'On this server only'}</dd>
${b.offsite ? html`<dt>Last run</dt><dd>${b.uploaded} file(s) sent, ${b.documents} document(s) covered</dd>` : ''}</dl>`;
})()}
<h2>WhatsApp listener</h2>
${health ? html`<dl class="working small">
<dt>Last heartbeat</dt><dd>${at(health.beatAt)}</dd>
<dt>Connected since</dt><dd>${at(health.readyAt)}</dd>
<dt>WhatsApp Web</dt><dd>${health.version || '—'}${config.waWebVersion ? html` · pinned to ${config.waWebVersion}${config.waWebVersionExpires ? ` until ${config.waWebVersionExpires}` : ''}` : ' · live version'}</dd>
<dt>whatsapp-web.js</dt><dd>${health.lib?.installed || '—'}${health.lib?.latest ? ` (latest ${health.lib.latest}, checked ${at(health.lib.checkedAt)})` : ''}</dd>
${health.stuck ? html`<dt>Last stuck start</dt><dd>${at(health.stuck.at)} · WhatsApp Web ${health.stuck.version || '?'}</dd>` : ''}
</dl>` : html`<p class="muted small">No listener has reported in from this machine.</p>`}
<p class="muted small">Next PO number: ${nextPo(ctx.db)} · <a href="/messages">WhatsApp messages queued</a></p>
<h2>Recent changes</h2>
<div class="card scroll"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
${trail.map((a) => html`<tr><td class="small">${a.at.slice(0, 16).replace('T', ' ')}</td><td>${a.actor}</td><td class="small">${a.action} ${a.entity} ${a.entity_id}</td></tr>`)}
</tbody></table></div>`;
  return { title: 'Settings', body };
}

export function saveSettings(ctx) {
  setSetting(ctx.db, 'cutover_date', date(ctx.form.get('cutover_date'), 'Cutover date') ?? '', { actor: ctx.actor });
  setSetting(ctx.db, 'amazon_ignored_shipments', list(ctx.form.get('amazon_ignored_shipments')).map((s) => s.toUpperCase()).join(', '), { actor: ctx.actor });
  return { redirect: '/settings?ok=Saved.' };
}

export function saveSuppliers(ctx) {
  const names = [...new Set(String(ctx.form.get('suppliers') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  setSetting(ctx.db, 'suppliers', names.join('\n'), { actor: ctx.actor });
  return { redirect: `/settings?ok=${encodeURIComponent('Suppliers saved.')}#suppliers` };
}
