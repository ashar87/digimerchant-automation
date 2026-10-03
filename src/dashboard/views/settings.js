import { html } from '../html.js';
import { getSetting, setSetting, nextPo, auditTrail } from '../../landing/store.js';
import { date } from '../forms.js';

export function settingsPage(ctx) {
  const cutover = getSetting(ctx.db, 'cutover_date');
  const trail = auditTrail(ctx.db, { limit: 30 });
  const body = html`
<h1>Settings</h1>
<form class="card" method="post" action="/settings">
<div class="grid"><div><label>Cutover date</label><input type="date" name="cutover_date" value="${cutover || ''}"></div></div>
<p class="muted small">From this date new orders go into the system, no new tabs are created, and the sheet becomes read-only history. Agree it with Atif.</p>
<button>Save</button></form>
<p class="muted small">Next PO number: ${nextPo(ctx.db)}</p>
<h2>Recent changes</h2>
<div class="card scroll"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
${trail.map((a) => html`<tr><td class="small">${a.at.slice(0, 16).replace('T', ' ')}</td><td>${a.actor}</td><td class="small">${a.action} ${a.entity} ${a.entity_id}</td></tr>`)}
</tbody></table></div>`;
  return { title: 'Settings', body };
}

export function saveSettings(ctx) {
  setSetting(ctx.db, 'cutover_date', date(ctx.form.get('cutover_date'), 'Cutover date') ?? '', { actor: ctx.actor });
  return { redirect: '/settings?ok=Saved.' };
}
