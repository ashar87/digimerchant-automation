/**
 * Stops one person's save silently overwriting another's. Every edit form
 * carries a fingerprint of the record as it was when the page was opened; a
 * save is refused if the record has changed since, and says who changed it.
 */
import crypto from 'node:crypto';
import { html } from './html.js';
import { HttpError } from './errors.js';
import { config } from '../config.js';

const london = (iso) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
  const day = d.toLocaleDateString('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'short' });
  return `${time} on ${day}`;
};

export function versionOf(record) {
  return crypto.createHash('sha256').update(JSON.stringify(record ?? null)).digest('hex').slice(0, 16);
}

export const versionField = (record) => html`<input type="hidden" name="version" value="${versionOf(record)}">`;

/** Throws 409 if `record` (as it is now) isn't the version the form was opened on. */
export function assertFresh(ctx, entity, id, record, back) {
  const sent = ctx.form.get('version');
  if (!sent) throw Object.assign(new HttpError(400, 'This form is out of date. Reload the page and make your change again.'), { back });
  if (sent === versionOf(record)) return;
  const last = ctx.db.prepare("SELECT at, actor FROM audit_log WHERE entity = ? AND entity_id = ? AND action != 'view' ORDER BY id DESC LIMIT 1").get(entity, id);
  const who = last ? `${last.actor === ctx.actor ? 'You (in another tab)' : last.actor} changed ${id} at ${london(last.at)}` : `${id} has changed`;
  throw Object.assign(new HttpError(409, `${who}, after you opened this page, so your change wasn’t saved. Open it again to see the latest, then make your change again.`), { back });
}
