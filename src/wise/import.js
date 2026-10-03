/**
 * Wise transfers become payment suggestions: amounts and date filled in, the
 * PO and part read from the reference ("PO-041 30%"). A person still confirms
 * each one on the dashboard; nothing is linked on amount alone.
 */
import { D } from '../landing/money.js';

const PO = /\bPO-\d{1,5}\b/i;
const DONE = new Set(['outgoing_payment_sent', 'funds_converted', 'processing', 'incoming_payment_waiting']);

export function saveTransfers(db, transfers) {
  const upsert = db.prepare(`INSERT INTO wise_transfers (id, created, reference, status, source_currency, source_value, target_currency, target_value, rate, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, reference = excluded.reference, raw = excluded.raw`);
  let n = 0;
  db.transaction(() => {
    for (const t of transfers) {
      if (!DONE.has(t.status)) continue; // cancelled or bounced transfers never cost anything
      const reference = t.reference || t.details?.reference || null;
      const val = (v) => (v === null || v === undefined ? null : D(v).toString());
      upsert.run(String(t.id), String(t.created), reference, t.status, t.sourceCurrency, val(t.sourceValue), t.targetCurrency, val(t.targetValue), val(t.rate), JSON.stringify(t));
      n++;
    }
  })();
  return n;
}

export function unrecordedTransfers(db) {
  return db.prepare('SELECT * FROM wise_transfers WHERE payment_id IS NULL AND ignored IS NULL ORDER BY created').all();
}

/** What the payment form is prefilled with for a transfer. */
export function paymentFromTransfer(t) {
  const reference = t.reference || '';
  const po = reference.match(PO)?.[0]?.toUpperCase() || null;
  const part = /\b(30|20|40)\s*%|deposit|定金/i.test(reference) ? 'deposit' : /balance|70\s*%|final|尾款/i.test(reference) ? 'balance' : /full|100\s*%/i.test(reference) ? 'full' : null;
  const p = { date: String(t.created).slice(0, 10), reference, wise: t.id };
  const put = (currency, value) => {
    if (currency === 'USD') p.usd = value;
    else if (currency === 'GBP') p.gbp = value;
    else if (currency === 'EUR') p.eur = value;
  };
  put(t.source_currency, t.source_value);
  put(t.target_currency, t.target_value); // e.g. GBP → USD gives both: GBP actually paid, USD sent
  if (t.source_currency === 'USD') p.funding = 'USD balance';
  else if (t.source_currency === 'GBP' && t.target_currency === 'CNY') p.funding = 'GBP straight to RMB';
  else if (t.source_currency) p.funding = t.source_currency;
  const rmb = t.target_currency === 'CNY' ? t.target_value : null;
  p.allocation = po ? { type: 'order', target: po, part, usd: p.usd, rmb } : null;
  return p;
}
