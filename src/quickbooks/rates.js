/**
 * Fills in the QB rate on payments that need one: USD or EUR paid towards a
 * UK or DE order or bill, with no GBP amount and no rate yet. Only an exact-day
 * rate is ever used; anything else is left "pending" and tried again later.
 */
import { loadLedger, saveLedger } from '../landing/store.js';

export function paymentsNeedingRate(ledger) {
  const ukde = new Set(ledger.orders.filter((o) => o.marketplace !== 'US').map((o) => o.po));
  const ukdeShipments = new Set(ledger.shipments.filter((s) => s.marketplace !== 'US').map((s) => s.id));
  const ukdeBills = new Set(ledger.courierBills.filter((b) => b.lines.some((l) => ukdeShipments.has(l.shipment))).map((b) => b.id));
  return ledger.payments.filter((p) => {
    if (p.gbp || p.qbRate || !(p.usd || p.eur)) return false;
    return (p.allocations || []).some((a) => (a.type === 'order' && ukde.has(a.target)) || (a.type === 'bill' && ukdeBills.has(a.target)));
  });
}

export async function fillRates({ db, qbo, actor = 'qb-rates', only = null }) {
  const ledger = loadLedger(db);
  const due = paymentsNeedingRate(ledger).filter((p) => !only || p.id === only);
  const record = db.prepare(`INSERT INTO qb_rate_lookups (payment_id, currency, date, status, rate, message, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(payment_id) DO UPDATE SET currency = excluded.currency, date = excluded.date, status = excluded.status, rate = excluded.rate, message = excluded.message, checked_at = excluded.checked_at`);
  const out = { found: [], pending: [], failed: [] };
  for (const p of due) {
    const currency = p.eur ? 'EUR' : 'USD';
    const at = new Date().toISOString();
    try {
      const r = await qbo.exchangeRate(currency, p.date);
      if (r.target && r.target !== 'GBP') throw new Error(`QuickBooks home currency is ${r.target}, not GBP`);
      if (r.rate) {
        saveLedger(db, { payments: [{ ...p, qbRate: r.rate }] }, { actor });
        record.run(p.id, currency, p.date, 'found', r.rate, null, at);
        out.found.push({ payment: p.id, rate: r.rate });
      } else {
        record.run(p.id, currency, p.date, 'pending', null, `QuickBooks has no ${currency} rate for ${p.date} yet${r.asOf ? ` (latest is ${r.asOf})` : ''}`, at);
        out.pending.push(p.id);
      }
    } catch (err) {
      record.run(p.id, currency, p.date, 'failed', null, err.message, at);
      out.failed.push({ payment: p.id, error: err.message });
    }
  }
  return out;
}

export function rateLookups(db) {
  return db.prepare("SELECT * FROM qb_rate_lookups WHERE status != 'found' ORDER BY date").all();
}
