import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openLandingDb } from '../landing/store.js';
import { seedTaskRefs, nextTaskRef, refNumber } from '../tasks/board.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS seen_messages (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  ref            TEXT PRIMARY KEY,      -- short human ref, e.g. A7
  chat_id        TEXT NOT NULL,
  chat_label     TEXT,
  title          TEXT NOT NULL,
  assignee       TEXT,
  due_date       TEXT,                  -- ISO yyyy-mm-dd
  priority       TEXT,
  notes          TEXT,
  quote          TEXT,                  -- the message that triggered it
  confidence     REAL,
  status         TEXT NOT NULL,         -- pending | approved | rejected | expired
  approval_msg_id TEXT,                 -- id of the WhatsApp card we sent you
  notion_url     TEXT,
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_msg ON candidates(approval_msg_id);

CREATE TABLE IF NOT EXISTS fingerprints (
  fingerprint TEXT PRIMARY KEY,
  ref         TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transcripts (
  message_id TEXT PRIMARY KEY,
  text       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// Added after the first release; ALTER is idempotent-guarded so existing DBs upgrade.
const columns = db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name);
if (!columns.includes('notion_database_id')) {
  db.exec('ALTER TABLE candidates ADD COLUMN notion_database_id TEXT');
}

const now = () => Date.now();

/* ---------- message dedupe (survives restarts) ---------- */

const _seen = db.prepare('SELECT 1 FROM seen_messages WHERE id = ?');
const _markSeen = db.prepare('INSERT OR IGNORE INTO seen_messages (id, created_at) VALUES (?, ?)');

export function alreadySeen(msgId) {
  return !!_seen.get(msgId);
}
export function markSeen(msgId) {
  _markSeen.run(msgId, now());
}

/* ---------- voice-note transcripts (cached, never transcribed twice) ---------- */

const _getTranscript = db.prepare('SELECT text FROM transcripts WHERE message_id = ?');
const _saveTranscript = db.prepare('INSERT OR REPLACE INTO transcripts (message_id, text, created_at) VALUES (?, ?, ?)');

/** Returns the cached transcript, or undefined if this audio has never been transcribed. */
export function getTranscript(messageId) {
  return _getTranscript.get(messageId)?.text;
}
export const saveTranscript = (messageId, text) => _saveTranscript.run(messageId, text, now());

/* ---------- short refs (A1, A2, ... B1 ...) ---------- */

const _getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
const _setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

/** The landing-cost database, where approved tasks live on the board. Opened on first use. */
let landing;
export const landingDb = () => (landing ??= openLandingDb(config.landingDbPath));

/**
 * Refs come from the board's counter, shared with tasks added on the dashboard,
 * so a number is never used twice. This database's own counter is folded in
 * (it was the only one before the board) and kept in step.
 */
export function nextRef() {
  const board = landingDb();
  seedTaskRefs(board, Number(_getMeta.get('ref_counter')?.value || 0));
  const ref = nextTaskRef(board);
  _setMeta.run('ref_counter', String(refNumber(ref)));
  return ref;
}

/* ---------- candidates ---------- */

const _insertCandidate = db.prepare(`
  INSERT INTO candidates (ref, chat_id, chat_label, title, assignee, due_date, priority, notes, quote, confidence, status, created_at, notion_database_id)
  VALUES (@ref, @chat_id, @chat_label, @title, @assignee, @due_date, @priority, @notes, @quote, @confidence, 'pending', @created_at, @notion_database_id)
`);

export function saveCandidate(c) {
  const ref = nextRef();
  _insertCandidate.run({
    ref,
    chat_id: c.chatId,
    chat_label: c.chatLabel ?? null,
    title: c.title,
    assignee: c.assignee ?? null,
    due_date: c.dueDate ?? null,
    priority: c.priority ?? null,
    notes: c.notes ?? null,
    quote: c.quote ?? null,
    confidence: c.confidence ?? null,
    created_at: now(),
    notion_database_id: c.notionDatabaseId ?? null,
  });
  return { ...c, ref, status: 'pending' };
}

const _attachMsg = db.prepare('UPDATE candidates SET approval_msg_id = ? WHERE ref = ?');
export const attachApprovalMessage = (ref, msgId) => _attachMsg.run(msgId, ref);

const _byRef = db.prepare('SELECT * FROM candidates WHERE ref = ?');
export const getCandidateByRef = (ref) => _byRef.get(String(ref).toUpperCase());

const _byMsg = db.prepare('SELECT * FROM candidates WHERE approval_msg_id = ?');
export const getCandidateByApprovalMsg = (msgId) => _byMsg.get(msgId);

const _pending = db.prepare("SELECT * FROM candidates WHERE status = 'pending' ORDER BY created_at ASC");
export const listPending = () => _pending.all();

const _decide = db.prepare('UPDATE candidates SET status = ?, notion_url = ?, decided_at = ? WHERE ref = ?');
export const decideCandidate = (ref, status, notionUrl = null) =>
  _decide.run(status, notionUrl, now(), String(ref).toUpperCase());

const _retitle = db.prepare('UPDATE candidates SET title = ? WHERE ref = ?');
export const retitleCandidate = (ref, title) => _retitle.run(title, String(ref).toUpperCase());

const _expire = db.prepare(
  "UPDATE candidates SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?"
);
export const expireStale = (maxAgeMs) => _expire.run(now(), now() - maxAgeMs).changes;

/* ---------- duplicate-task suppression ---------- */

const _fp = db.prepare('SELECT ref FROM fingerprints WHERE fingerprint = ? AND created_at > ?');
const _addFp = db.prepare('INSERT OR REPLACE INTO fingerprints (fingerprint, ref, created_at) VALUES (?, ?, ?)');

export function fingerprintOf(chatId, title) {
  const norm = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .sort()
    .join('-');
  return `${chatId}::${norm}`;
}

/** True if an equivalent task was already raised in this chat within `windowDays`. */
export function isDuplicate(fingerprint, windowDays = 14) {
  return !!_fp.get(fingerprint, now() - windowDays * 86400_000);
}
export const rememberFingerprint = (fingerprint, ref) => _addFp.run(fingerprint, ref, now());

/* ---------- voice notes we couldn't read, retried later ---------- */

db.exec(`
CREATE TABLE IF NOT EXISTS missed_media (
  id          INTEGER PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  author      TEXT,
  ts          INTEGER NOT NULL,          -- message time, seconds
  hash        TEXT,                      -- the message's id hash; NULL = find voice notes around ts
  reason      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | recovered | given_up
  created_at  INTEGER NOT NULL
);
`);

export function recordMissed({ chatId, author = null, timestamp, hash = null, reason = null }) {
  if (hash && db.prepare('SELECT 1 FROM missed_media WHERE hash = ?').get(hash)) return;
  db.prepare('INSERT INTO missed_media (chat_id, author, ts, hash, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(chatId, author, timestamp, hash, reason, now());
}
export const pendingMissed = () => db.prepare("SELECT * FROM missed_media WHERE status = 'pending' ORDER BY ts").all();
export const settleMissed = (id, status) => db.prepare('UPDATE missed_media SET status = ? WHERE id = ?').run(status, id);
export const triedMissed = (id, reason) => db.prepare('UPDATE missed_media SET attempts = attempts + 1, reason = ? WHERE id = ?').run(reason, id);
/** A search row ("voice notes around this time") replaced by the notes it found. */
export function expandMissed(row, hashes) {
  db.transaction(() => {
    for (const h of hashes) recordMissed({ chatId: row.chat_id, author: row.author, timestamp: row.ts, hash: h, reason: row.reason });
    db.prepare('DELETE FROM missed_media WHERE id = ?').run(row.id);
  })();
}
export const getMeta = (key) => _getMeta.get(key)?.value ?? null;
export const setMeta = (key, value) => _setMeta.run(key, String(value));

export default db;
