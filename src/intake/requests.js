/**
 * What's said around the files in the supplier group:
 *
 * - After each batch Atif writes the total to send ("1250$ send krny supplier
 *   ko", sometimes "12000 RMB …"). It's kept as a payment request, and the Wise
 *   messages that follow are set against it, oldest request first: one
 *   request can be paid in two transfers, and a transfer can't silently be $9
 *   more or less than was asked.
 * - Which message each reply answers. A corrected invoice is sent as a reply,
 *   to the first version or to Ashar's feedback on it, so following the
 *   replies back finds the version it corrects.
 */
import { D, ZERO, fmtMoney, fmtRmb } from '../landing/money.js';

const ASK = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(\$|usd\b|rmb\b|cny\b|yuan\b)/i;
const WINDOW_DAYS = 14;
// A transfer this close to what's left is taken as paying it in full (Wise amounts are rounded).
const SLACK = { USD: D(1), CNY: D(5) };

/** "1250$ send krny supplier ko" → { currency: 'USD', amount: '1250' }; null for anything else. */
export function parseRequest(body = '') {
  const m = ASK.exec(body);
  if (!m) return null;
  return { currency: /^(\$|usd)/i.test(m[3]) ? 'USD' : 'CNY', amount: D(m[1] + (m[2] || '')).toString() };
}

export function noteRequest(db, { id, chat, author, timestamp, currency, amount }) {
  db.prepare('INSERT OR IGNORE INTO pay_requests (id, chat, author, at, currency, amount) VALUES (?, ?, ?, ?, ?, ?)').run(id, chat, author, new Date(timestamp * 1000).toISOString(), currency, amount);
}

export const fmtAmount = (currency, v) => (currency === 'USD' ? `$${fmtMoney(v).replace(/\.00$/, '')}` : `${fmtRmb(v)} RMB`);
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });

/**
 * Sets a transfer against the open requests in the chat, oldest first, and
 * says how it compares (one line for the Wise card), or null if nothing was
 * asked for in that currency in the last two weeks.
 */
export function applyPayment(db, { chat, currency, amount, timestamp }) {
  const at = new Date(timestamp * 1000);
  const since = new Date(at.getTime() - WINDOW_DAYS * 86400_000).toISOString();
  const open = db.prepare('SELECT * FROM pay_requests WHERE chat = ? AND currency = ? AND closed_at IS NULL AND at >= ? AND at <= ? ORDER BY at').all(chat, currency, since, at.toISOString());
  if (!open.length) return null;
  const slack = SLACK[currency] || ZERO;
  let left = D(amount);
  const paid = [];
  for (const r of open) {
    if (left.lte(0)) break;
    const due = D(r.amount).minus(r.paid);
    const take = left.gte(due) ? due : left;
    left = left.minus(take);
    const still = due.minus(take);
    const closed = still.lte(slack);
    db.prepare('UPDATE pay_requests SET paid = ?, closed_at = ? WHERE id = ?').run(D(r.paid).plus(take).toString(), closed ? at.toISOString() : null, r.id);
    paid.push({ ...r, still, closed });
  }
  const last = paid.at(-1);
  const asked = (r) => `${fmtAmount(currency, r.amount)} ${r.author || 'Atif'} asked for on ${day(r.at)}`;
  if (left.gt(slack)) return `⚠️ ${fmtAmount(currency, left)} more than the ${asked(last)}.`;
  if (!last.closed) return `Part of the ${asked(last)}: ${fmtAmount(currency, last.still)} still to send.`;
  if (last.still.gt(0)) return `⚠️ ${fmtAmount(currency, last.still)} less than the ${asked(last)}.`;
  if (paid.length > 1) return `✓ Pays ${paid.map((r) => `${fmtAmount(currency, r.amount)} of ${day(r.at)}`).join(' and ')}, as asked.`;
  return D(last.amount).gt(amount) ? `✓ That completes the ${asked(last)}.` : `✓ Exactly the ${asked(last)}.`;
}

/** Remembers which message a reply answers. */
export function noteReply(db, { id, quoted, timestamp }) {
  if (id && quoted) db.prepare('INSERT OR IGNORE INTO group_replies (id, quoted, at) VALUES (?, ?, ?)').run(id, quoted, new Date(timestamp * 1000).toISOString());
}

/** The messages a reply answers, nearest first: the one it quotes, the one that quotes, … (three at most). */
export function replyChain(db, quoted, hops = 3) {
  const chain = [];
  for (let id = quoted; id && chain.length < hops && !chain.includes(id); id = db.prepare('SELECT quoted FROM group_replies WHERE id = ?').get(id)?.quoted) chain.push(id);
  return chain;
}
