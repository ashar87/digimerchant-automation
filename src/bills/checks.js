/**
 * Arithmetic checks on a read courier bill, by plain calculation rather than
 * by trusting whatever read it: the lines against the bill's total, the USD
 * against the RMB at the bill's own rate, and Annie's 1% service fee.
 */
import { D, ZERO, sum, fmtRmb, fmtMoney } from '../landing/money.js';

const n = (v) => (v === null || v === undefined || v === '' ? null : D(v));

export function checkBill(reading) {
  const checks = [...(reading.notes || [])];
  const ok = (message) => checks.push({ severity: 'ok', message });
  const warn = (message) => checks.push({ severity: 'warning', message });
  const lines = reading.lines || [];

  const amounts = lines.map((l) => n(l.rmb));
  const linesTotal = amounts.length && amounts.every((a) => a !== null) ? sum(amounts) : null;
  const stated = n(reading.statedTotalRmb);
  if (linesTotal !== null && stated !== null) {
    if (linesTotal.minus(stated).abs().lte('0.5')) ok(`Lines add up to the bill total, ${fmtRmb(stated)} RMB ✓`);
    else warn(`Lines add up to ${fmtRmb(linesTotal)} RMB, but the bill total says ${fmtRmb(stated)} RMB (${linesTotal.gt(stated) ? 'lines over' : 'lines under'} by ${fmtRmb(linesTotal.minus(stated).abs())}).`);
  }

  const rate = n(reading.rmbPerUsd);
  const usd = n(reading.totalUsd);
  const total = stated ?? linesTotal;
  if (rate !== null && usd !== null && total !== null && rate.gt(0)) {
    const expected = total.div(rate);
    if (expected.minus(usd).abs().lte(1)) ok(`${fmtRmb(total)} RMB at ${rate} is $${fmtMoney(expected)}; the bill asks $${fmtMoney(usd)} ✓`);
    else warn(`${fmtRmb(total)} RMB at ${rate} is $${fmtMoney(expected)}, but the bill asks $${fmtMoney(usd)} ($${fmtMoney(usd.minus(expected).abs())} ${usd.gt(expected) ? 'over' : 'under'}). Raise it with ${reading.agent || 'the agent'}.`);
  }

  // Annie charges 1% of the shipping she arranged (domestic legs included).
  const shipping = sum(lines.filter((l) => ['shipping', 'domestic', 'onward'].includes(l.kind)).map((l) => n(l.rmb) ?? ZERO));
  for (const fee of lines.filter((l) => l.kind === 'fee' && n(l.rmb) !== null)) {
    if (!shipping.gt(0)) continue;
    const expected = shipping.div(100);
    if (n(fee.rmb).minus(expected).abs().lte(1)) ok(`Service fee ${fmtRmb(fee.rmb)} is 1% of the shipping (${fmtRmb(shipping)}) ✓`);
    else warn(`Service fee ${fmtRmb(fee.rmb)} is ${n(fee.rmb).div(shipping).times(100).toFixed(2)}% of the shipping (${fmtRmb(shipping)}), not 1%.`);
  }

  for (const field of reading.unread || []) warn(`${field} couldn’t be read; it’s left blank, not guessed.`);
  return checks;
}
