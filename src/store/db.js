import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

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

export function nextRef() {
  const n = Number(_getMeta.get('ref_counter')?.value || 0) + 1;
  _setMeta.run('ref_counter', String(n));
  const letter = String.fromCharCode(65 + Math.floor((n - 1) / 99) % 26); // A..Z
  const digits = ((n - 1) % 99) + 1;
  return `${letter}${digits}`;
}

/* ---------- candidates ---------- */

const _insertCandidate = db.prepare(`
  INSERT INTO candidates (ref, chat_id, chat_label, title, assignee, due_date, priority, notes, quote, confidence, status, created_at)
  VALUES (@ref, @chat_id, @chat_label, @title, @assignee, @due_date, @priority, @notes, @quote, @confidence, 'pending', @created_at)
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

export default db;
