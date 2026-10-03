/**
 * The queue of WhatsApp cards. Producers (Amazon sync, courier bills, the
 * dashboard) only ever enqueue; the listener, which owns the one WhatsApp
 * session, sends and records replies. Two programs on one session would fight
 * over it.
 */

const now = () => new Date().toISOString();

/** Queues a card. Returns its id, or null if a card with this dedupe key already exists. */
export function enqueue(db, { kind, text, dedupeKey = null, payload = null, needsReply = false }) {
  const res = db
    .prepare('INSERT INTO outbox (kind, dedupe_key, text, payload, needs_reply, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING')
    .run(kind, dedupeKey, text, payload ? JSON.stringify(payload) : null, needsReply ? 1 : 0, now());
  return res.changes ? Number(res.lastInsertRowid) : null;
}

const parse = (row) => row && { ...row, needs_reply: !!row.needs_reply, payload: row.payload ? JSON.parse(row.payload) : null };

/** Cards the listener hasn't sent yet, oldest first. */
export function unsent(db, limit = 20) {
  return db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT ?').all(limit).map(parse);
}

export function markSent(db, id, waMessageId = null) {
  db.prepare('UPDATE outbox SET sent_at = ?, wa_message_id = ? WHERE id = ?').run(now(), waMessageId, id);
}

/** Cards still waiting for a Y or N. */
export function awaitingReply(db) {
  return db.prepare('SELECT * FROM outbox WHERE needs_reply = 1 AND reply IS NULL ORDER BY id').all().map(parse);
}

export function findByWaMessage(db, waMessageId) {
  return parse(db.prepare('SELECT * FROM outbox WHERE wa_message_id = ?').get(waMessageId));
}

export function getCard(db, id) {
  return parse(db.prepare('SELECT * FROM outbox WHERE id = ?').get(id));
}

export function recordReply(db, id, reply, by) {
  db.prepare('UPDATE outbox SET reply = ?, replied_by = ?, replied_at = ? WHERE id = ? AND reply IS NULL').run(reply, by, now(), id);
}

export function recent(db, limit = 50) {
  return db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT ?').all(limit).map(parse);
}
