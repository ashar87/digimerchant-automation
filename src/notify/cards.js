/**
 * The words on each WhatsApp card. Short, figures first, one decision at most.
 */
import { D, fmt4, fmtRmb } from '../landing/money.js';

const sym = (currency) => (currency === 'USD' ? '$' : '£');
const unit = (v, currency) => (v === null || v === undefined ? '—' : `${sym(currency)}${fmt4(v)}`);
const n = (v) => fmtRmb(D(v));

export function shipmentClosedCard({ shipment, marketplace, lines }) {
  const out = [`📦 ${shipment} closed (${marketplace})`];
  for (const l of lines) {
    const diff = D(l.received).minus(D(l.shipped));
    const note = diff.isZero() ? '' : diff.lt(0) ? `, ${n(diff.abs())} short` : `, ${n(diff)} over`;
    out.push(`${n(l.received)} of ${n(l.shipped)} ${l.code} received${note}.`);
    if (l.productBefore && l.productAfter && !D(l.productBefore).eq(D(l.productAfter))) {
      out.push(`Product cost ${unit(l.productBefore, l.currency)} → ${unit(l.productAfter, l.currency)}`);
    }
    if (l.landing) out.push(`Landing cost ${unit(l.landing, l.currency)} · ${l.status === 'final' ? 'final' : statusWords(l.status)}`);
  }
  return out.join('\n');
}

export function linkRequestCard({ shipment, marketplace, lines, candidate }) {
  const out = [`🔗 New shipment ${shipment} (${marketplace})`, ...lines.map((l) => `${n(l.qty)} × ${l.name}`)];
  if (candidate) {
    out.push(`Matches ${candidate.po} (${candidate.supplier}, ${n(candidate.open)} open).`);
    out.push('Reply Y to link, N to choose another on the dashboard.');
  } else {
    out.push('No open order matches. Link it on the dashboard.');
  }
  return out.join('\n');
}

export function shortfallCard({ shipment, marketplace, code, shipped, received, valueAtCost, currency }) {
  const short = D(shipped).minus(D(received));
  const value = valueAtCost === null || valueAtCost === undefined ? '' : `, about ${sym(currency)}${fmtRmb(D(valueAtCost).toDecimalPlaces(0))} at cost`;
  return [`⚠️ ${shipment} closed (${marketplace})`, `${n(received)} of ${n(shipped)} ${code} received, ${n(short)} short${value}.`, 'Worth checking whether Amazon or the supplier came up short.'].join('\n');
}

export function costChangeCard({ shipment, marketplace, code, before, after, currency, status, reason }) {
  const pct = D(after).minus(D(before)).div(D(before)).times(100);
  return [
    `💷 ${code} ${marketplace} in ${shipment}: landing cost ${unit(before, currency)} → ${unit(after, currency)} (${pct.gt(0) ? '+' : ''}${pct.toFixed(1)}%)`,
    reason ? reason : null,
    `Now ${statusWords(status)}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function statusWords(status) {
  return { final: 'final', count_pending: 'awaiting Amazon count', estimated: 'delivery estimated', provisional: 'deposit only', incomplete: 'incomplete' }[status] || status;
}
