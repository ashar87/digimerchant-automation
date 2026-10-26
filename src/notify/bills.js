/**
 * A card when a courier bill turns delivery estimates into billed costs. That
 * happens when the bill and its payment are both on file, so it's checked
 * after either is saved. Other moves over 2% get the usual cost-change card.
 */
import { loadLedger } from '../landing/store.js';
import { computeLandingCosts } from '../landing/engine.js';
import { fmt4 } from '../landing/money.js';
import { enqueue } from './outbox.js';
import { queueCostChanges } from './costs.js';
import { refreshSellerboardTasks } from '../sellerboard/tasks.js';

export function queueBillCards(db, billIds, before) {
  const ledger = loadLedger(db);
  const after = computeLandingCosts(ledger);
  const touched = new Set();
  for (const bill of ledger.courierBills.filter((b) => billIds.includes(b.id))) {
    const ids = new Set(bill.lines.map((l) => l.shipment).filter(Boolean));
    ids.forEach((id) => touched.add(id));
    const changes = after.shipments
      .filter((s) => ids.has(s.id) && s.delivery.basis === 'billed')
      .map((s) => {
        const was = before.shipments.find((x) => x.id === s.id)?.delivery;
        if (was?.basis === 'billed' && was.perUnit?.eq(s.delivery.perUnit)) return null;
        const sym = s.currency === 'USD' ? '$' : '£';
        const from = was?.perUnit ? `${was.basis === 'estimated' ? 'est. ' : ''}${sym}${fmt4(was.perUnit)} → ` : '';
        return `${s.id} (${s.marketplace}): delivery ${from}${sym}${fmt4(s.delivery.perUnit)} a unit`;
      })
      .filter(Boolean);
    if (changes.length) {
      enqueue(db, {
        kind: 'bill_saved',
        dedupeKey: `bill:${bill.id}:${changes.join('|')}`,
        text: [`🧾 Courier bill ${bill.id}${bill.date ? ` (${bill.date})` : ''}`, ...changes, 'These delivery costs are now billed, not estimated.'].join('\n'),
      });
    }
  }
  queueCostChanges(db, after, { skipShipments: touched, reason: 'After a courier bill or payment was entered.' });
  refreshSellerboardTasks(db, { ledger, result: after });
}
