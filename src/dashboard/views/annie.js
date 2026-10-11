import { html, rmb, money } from '../html.js';
import { D, ZERO } from '../../landing/money.js';
import { enc } from './common.js';

// Gold re-pricing is also an adjustment, but it belongs to the supplier, not Annie's account.
// Whole phrases only: a fee bundle that merely mentions "rate diff" (PO-005) isn't a carried difference.
const CARRIED = /rate difference|payment difference|carried forward|\bcredit\b/i;

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

/**
 * Annie's account, on the Payments page: the credit held with her on one line,
 * the history folded underneath.
 */
export function annieSection(ledger) {
  const entries = annieEntries(ledger);
  if (!entries.length) return '';
  const creditTotal = entries.filter((e) => e.usd !== null).reduce((acc, e) => acc.plus(e.usd), ZERO);
  return html`<div class="card" id="annie"><b>Credit with Annie: ${money(creditTotal, 'USD')}</b> carried forward${creditTotal.gt(0) ? html`. Check her next invoice deducts it.` : '.'}
<details class="small"><summary>Rate differences and credits (${entries.length})</summary>
<p class="muted">Rate differences carried from one invoice to the next, and money held as credit. A positive RMB line was added to an invoice (we paid more); a negative one was taken off.</p>
<div class="scroll"><table>
<thead><tr><th>Date</th><th>On</th><th>What</th><th class="n">RMB</th><th class="n">USD credit</th></tr></thead>
<tbody>${entries.map((e) => html`<tr><td>${e.date || ''}</td><td><a href="${e.href}">${e.source}</a></td><td>${e.description}</td><td class="n">${e.rmb && !e.rmb.isNaN() ? rmb(e.rmb) : ''}</td><td class="n">${e.usd ? money(e.usd, 'USD') : ''}</td></tr>`)}
</tbody></table></div></details></div>`;
}

/** The old Annie tab's address, kept so links still land somewhere. */
export function anniePage() {
  return { redirect: '/payments#annie' };
}
