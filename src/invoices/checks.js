/**
 * Arithmetic checks on a read invoice, done by plain calculation rather than
 * by trusting whatever read it. This is how the courier-bill errors in the
 * sheet were found (a stated total that left out the service fee; USD billed
 * at a rate the RMB didn't support).
 */
import { D, ZERO, sum, fmtRmb } from '../landing/money.js';

const n = (v) => (v === null || v === undefined || v === '' ? null : D(v));
const r = (v) => fmtRmb(v);
// Within half a yuan, or half a percent of the amount, whichever is larger.
const close = (a, b, pct = '0.005') => {
  const allowed = b.abs().times(pct);
  return a.minus(b).abs().lte(allowed.gt('0.5') ? allowed : D('0.5'));
};

export function checkReading(reading) {
  const checks = [];
  const ok = (message) => checks.push({ severity: 'ok', message });
  const warn = (message) => checks.push({ severity: 'warning', message });

  const lines = reading.lines || [];
  lines.forEach((l, i) => {
    const qty = n(l.qty);
    const unit = n(l.unitPrice);
    const amount = n(l.rmb);
    const label = `Line ${i + 1}${l.description ? ` (${String(l.description).slice(0, 40)})` : ''}`;
    if (amount === null) return warn(`${label}: the amount couldn’t be read. Enter it from the invoice.`);
    if (qty !== null && unit !== null) {
      const expected = qty.times(unit);
      if (close(amount, expected)) ok(`${label}: ${r(qty)} × ${unit.toString()} = ${r(amount)} ✓`);
      else warn(`${label}: ${r(qty)} × ${unit.toString()} = ${r(expected)}, but the line says ${r(amount)}.`);
    }
  });

  const amounts = lines.map((l) => n(l.rmb));
  const linesTotal = amounts.every((a) => a !== null) && amounts.length ? sum(amounts) : null;
  const stated = n(reading.statedTotalRmb);
  if (linesTotal !== null && stated !== null) {
    if (close(linesTotal, stated, '0')) ok(`Lines add up to the invoice total, ${r(stated)} RMB ✓`);
    else warn(`Lines add up to ${r(linesTotal)} RMB, but the invoice total says ${r(stated)} RMB (${linesTotal.gt(stated) ? 'lines over' : 'lines under'} by ${r(linesTotal.minus(stated).abs())}).`);
  } else if (stated === null) {
    warn('No invoice total could be read, so the lines can’t be checked against it.');
  }

  const goods = sum(lines.filter((l) => l.kind === 'goods').map((l) => n(l.rmb) ?? ZERO));
  for (const fee of lines.filter((l) => l.kind === 'fee' && n(l.rmb) !== null)) {
    const pct = goods.gt(0) ? n(fee.rmb).div(goods).times(100) : null;
    if (pct && pct.minus(1).abs().lte('0.05')) ok(`Service fee ${r(fee.rmb)} is 1% of the goods (${r(goods)}) ✓`);
    else if (pct) warn(`Service fee ${r(fee.rmb)} is ${pct.toFixed(2)}% of the goods (${r(goods)}), not 1%.`);
  }

  const total = linesTotal ?? stated;
  const pct = n(reading.depositPercent);
  const deposit = n(reading.depositRmb);
  if (total && pct !== null && deposit !== null) {
    const expected = total.times(pct).div(100);
    if (deposit.minus(expected).abs().lte(1)) ok(`Deposit ${r(deposit)} is ${pct.toString()}% of ${r(total)} ✓`);
    else warn(`Deposit ${r(deposit)} is ${deposit.div(total).times(100).toFixed(1)}% of ${r(total)}, not ${pct.toString()}%. Normal for gold-priced orders; check it’s the agreed amount.`);
  }
  const received = n(reading.depositReceivedRmb);
  const balance = n(reading.balanceRmb);
  if (total && received !== null && balance !== null) {
    if (received.plus(balance).minus(total).abs().lte(1)) ok(`Deposit received ${r(received)} + balance ${r(balance)} = ${r(total)} ✓`);
    else warn(`Deposit received ${r(received)} + balance ${r(balance)} = ${r(received.plus(balance))}, not the invoice’s ${r(total)}.`);
  }

  for (const field of reading.unread || []) warn(`${field} couldn’t be read; it’s left blank, not guessed.`);
  return checks;
}
