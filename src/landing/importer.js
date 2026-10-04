/**
 * Imports records (orders, payments, courier bills, shipments, products) as
 * drafts. Safe to run again: a record already on file is only replaced if
 * nobody but the importer has touched it since. Anything edited on the
 * dashboard, updated by the Amazon sync, or marked checked is kept, unless
 * `force` is set.
 */
import { loadLedger, saveLedger } from './store.js';

const TYPES = [
  { key: 'products', id: 'id', entity: 'product' },
  { key: 'orders', id: 'po', entity: 'order' },
  { key: 'courierBills', id: 'id', entity: 'courier_bill' },
  { key: 'shipments', id: 'id', entity: 'shipment' },
  { key: 'payments', id: 'id', entity: 'payment' },
];

export function importLedger(db, input, { force = false, actor = 'import' } = {}) {
  const incoming = structuredClone(input.ledger || input);
  const current = loadLedger(db);
  // Who has ever written each record: if anyone besides the importer, it's theirs now.
  const touchedBy = db.prepare('SELECT DISTINCT actor FROM audit_log WHERE entity = ? AND entity_id = ?');
  const touched = (entity, id) => touchedBy.all(entity, id).some((r) => r.actor !== actor);

  const report = { added: {}, replaced: {}, kept: {} };
  const toWrite = {};
  for (const t of TYPES) {
    report.added[t.key] = [];
    report.replaced[t.key] = [];
    report.kept[t.key] = [];
    const existing = new Map((current[t.key] || []).map((r) => [r[t.id], r]));
    toWrite[t.key] = [];
    for (const record of incoming[t.key] || []) {
      const id = record[t.id];
      const before = existing.get(id);
      if (t.key === 'orders') record.review = 'needs_review';
      if (!before) {
        report.added[t.key].push(id);
        toWrite[t.key].push(record);
      } else if (force || (!touched(t.entity, id) && before.review !== 'reviewed')) {
        report.replaced[t.key].push(id);
        toWrite[t.key].push(record);
      } else {
        report.kept[t.key].push(id);
      }
    }
  }
  saveLedger(db, toWrite, { actor });
  return report;
}
