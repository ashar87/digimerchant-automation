import { html, rmb, money } from '../html.js';
import { D, ZERO } from '../../landing/money.js';
import { enc } from './common.js';

// Gold re-pricing is also an adjustment, but it belongs to the supplier, not Annie's account.
const CARRIED = /rate diff|payment diff|credit|carried/i;

/**
 * The running account with Annie, the sourcing agent: rate differences carried
 * between invoices and overpayments held as credit. Built from the records,
 * never typed in.
 */
export function annieEntries(ledger) {
  const entries = [];
  for (const o of ledger.orders) {
    for (const inv of o.invoices || []) {
      for (const l of inv.lines || []) {
        if (l.kind !== 'adjustment' || !CARRIED.test(l.description || '')) continue;
        entries.push({ date: inv.date, source: o.po, href: `/orders/${enc(o.po)}`, description: l.description || 'Adjustment', rmb: D(l.rmb), usd: null });
      }
    }
  }
  for (const b of ledger.courierBills) {
    for (const l of b.lines || []) {
      if (l.kind !== 'adjustment' || !CARRIED.test(l.description || '')) continue;
      entries.push({ date: b.date, source: b.id, href: `/bills/${enc(b.id)}`, description: l.description || 'Adjustment', rmb: D(l.rmb), usd: null });
    }
  }
  for (const p of ledger.payments) {
    for (const a of p.allocations || []) {
      if (a.type !== 'credit') continue;
      entries.push({ date: p.date, source: p.id, href: `/payments/${enc(p.id)}`, description: a.description || `Credit with ${a.target || 'agent'}`, rmb: D(a.rmb), usd: D(a.usd) });
    }
  }
  return entries.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
}

export function anniePage(ctx) {
  const entries = annieEntries(ctx.data.ledger);
  const credits = entries.filter((e) => e.usd !== null);
  const creditTotal = credits.reduce((acc, e) => acc.plus(e.usd), ZERO);
  const body = html`
<h1>Annie</h1>
<p class="sub">Rate differences carried from one invoice to the next, and money held as credit. A positive RMB line was added to an invoice (we paid more); a negative one was taken off.</p>
<div class="card scroll"><table>
<thead><tr><th>Date</th><th>On</th><th>What</th><th class="n">RMB</th><th class="n">USD credit</th></tr></thead>
<tbody>${entries.map((e) => html`<tr><td>${e.date || ''}</td><td><a href="${e.href}">${e.source}</a></td><td>${e.description}</td><td class="n">${e.rmb ? rmb(e.rmb) : ''}</td><td class="n">${e.usd ? money(e.usd, 'USD') : ''}</td></tr>`)}
<tr class="total"><td colspan="4">Credit carried forward</td><td class="n">${money(creditTotal, 'USD')}</td></tr></tbody></table></div>
<p class="muted small">The next invoice should show any credit carried forward. If it doesn’t, raise it with Annie.</p>`;
  return { title: 'Annie', body };
}
