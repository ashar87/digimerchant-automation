/**
 * Sends the dashboard's queued cards (Amazon sync, courier bills, cost changes)
 * to the WhatsApp self-chat. Run by the listener, which owns the WhatsApp session.
 *
 * Cards that need an answer go one by one, each with a number to answer by
 * ("Y #12"); the rest of a round are combined into one digest, so a morning
 * with ten updates is one message, not ten.
 */
import { unsent, markSent } from './outbox.js';

/** The card with its answer line: "Reply Y #12 or N #12", replacing the generic one. */
export function withAnswerLine(card) {
  const lines = card.text.split('\n').filter((l) => !/^reply y\b/i.test(l.trim()));
  return [...lines, `Reply *Y #${card.id}* or *N #${card.id}*, or answer this message with Y or N.`].join('\n');
}

/**
 * Sends what's queued. `send(text)` resolves to { key } once sent, or null when
 * nothing was sent (dry run): the cards then stay queued. Returns the number sent.
 */
export async function deliverOutbox(db, send, { limit = 20 } = {}) {
  const cards = unsent(db, limit);
  if (!cards.length) return 0;
  let sent = 0;

  const notes = cards.filter((c) => !c.needs_reply);
  if (notes.length) {
    const text = notes.length === 1 ? notes[0].text : [`🗒️ ${notes.length} updates from the dashboard`, ...notes.map((c) => c.text)].join('\n\n');
    const out = await send(text);
    if (out === null) return 0;
    for (const c of notes) markSent(db, c.id, out?.key ?? null);
    sent += notes.length;
  }
  for (const c of cards.filter((x) => x.needs_reply)) {
    const out = await send(withAnswerLine(c));
    if (out === null) return sent;
    markSent(db, c.id, out?.key ?? null);
    sent++;
  }
  return sent;
}

/** "Y #12", "n#12", "#12 yes" → { id: 12, verb: 'Y' }; anything else → null. */
export function parseCardAnswer(body) {
  const m = String(body).trim().match(/^(?:(y|yes|n|no)\s*#(\d+)|#(\d+)\s*(y|yes|n|no))$/i);
  if (!m) return null;
  const verb = (m[1] || m[4]).toLowerCase().startsWith('y') ? 'Y' : 'N';
  return { id: Number(m[2] || m[3]), verb };
}
