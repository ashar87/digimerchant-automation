/**
 * Amazon shipments set aside: old shipments from before the dashboard with no
 * PO, or returned stock sent back in. The sync skips them, so a removed one
 * doesn't come back. Kept in settings (amazon_ignored_shipments), editable on
 * the Settings page.
 */
import { getSetting, setSetting, deleteRecord } from '../landing/store.js';

const KEY = 'amazon_ignored_shipments';

export function ignoredShipments(db) {
  return new Set(String(getSetting(db, KEY) || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
}

/**
 * Removes the shipment from the dashboard, remembers to skip it, and clears its
 * WhatsApp cards: unsent ones are dropped, ones awaiting a reply are closed.
 */
export function ignoreShipment(db, id, { actor }) {
  const ids = ignoredShipments(db);
  ids.add(id.toUpperCase());
  db.transaction(() => {
    deleteRecord(db, 'shipment', id, { actor });
    setSetting(db, KEY, [...ids].join(', '), { actor });
    const mine = (c) => {
      const payload = c.payload ? JSON.parse(c.payload) : null;
      return payload?.shipment === id || String(c.dedupe_key || '').split(':')[1] === id;
    };
    for (const c of db.prepare('SELECT * FROM outbox WHERE reply IS NULL').all().filter(mine)) {
      if (!c.sent_at) db.prepare('DELETE FROM outbox WHERE id = ?').run(c.id);
      else if (c.needs_reply) db.prepare("UPDATE outbox SET reply = 'IGNORED', replied_by = ?, replied_at = ? WHERE id = ?").run(actor, new Date().toISOString(), c.id);
    }
  })();
}
