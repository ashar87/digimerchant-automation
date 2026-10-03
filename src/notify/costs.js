/**
 * Tells you when a batch's landing cost moves by more than 2% from what it
 * was last reported at: a count arriving, a courier bill replacing an
 * estimate, a corrected rate. Smaller moves are rounding noise.
 */
import { D } from '../landing/money.js';
import { enqueue } from './outbox.js';
import { costChangeCard } from './cards.js';

export const COST_CHANGE_THRESHOLD = D('0.02');

/**
 * Compares every batch with its snapshot, queues a card for real changes,
 * then moves the snapshots on. The first time a batch is seen it is recorded
 * silently. Returns the number of cards queued.
 */
export function queueCostChanges(db, result, { skipShipments = new Set(), reason = null } = {}) {
  const get = db.prepare('SELECT landing, status FROM batch_snapshots WHERE shipment = ? AND product = ?');
  const put = db.prepare('INSERT INTO batch_snapshots (shipment, product, landing, status, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(shipment, product) DO UPDATE SET landing = excluded.landing, status = excluded.status, at = excluded.at');
  const at = new Date().toISOString();
  let queued = 0;

  db.transaction(() => {
    for (const b of result.batches) {
      if (b.landingCost === null) continue;
      const snap = get.get(b.shipment, b.product);
      const before = snap?.landing ? D(snap.landing) : null;
      if (before && before.gt(0) && !skipShipments.has(b.shipment)) {
        const change = b.landingCost.minus(before).abs().div(before);
        if (change.gt(COST_CHANGE_THRESHOLD)) {
          const id = enqueue(db, {
            kind: 'cost_change',
            dedupeKey: `cost:${b.shipment}:${b.product}:${b.landingCost.toFixed(4)}`,
            text: costChangeCard({ shipment: b.shipment, marketplace: b.marketplace, code: b.code || b.product, before, after: b.landingCost, currency: b.currency, status: b.status, reason }),
          });
          if (id) queued++;
        }
      }
      put.run(b.shipment, b.product, b.landingCost.toString(), b.status, at);
    }
  })();
  return queued;
}
