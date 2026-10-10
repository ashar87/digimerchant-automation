/**
 * The task board, kept in the landing-cost database next to orders and costs.
 *
 * Tasks come from two places: added by hand on the dashboard, or approved from
 * WhatsApp. Both draw refs from one counter (A1…A99, B1…), so a ref means the
 * same task wherever it's mentioned. The counter lives in `settings` here; the
 * WhatsApp listener's older counter is folded in once with seedTaskRefs().
 *
 * Every change goes in audit_log (entity 'task') with the whole task, so the
 * edit page can show what changed, by whom.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

export const STATUSES = [
  { value: 'new', label: 'New' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];
export const PEOPLE = ['Ashar', 'Atif'];
export const PRIORITIES = ['high', 'medium', 'low'];
export const DONE_DAYS = 14;

export const statusLabel = (s) => STATUSES.find((x) => x.value === s)?.label || s;

/** n → "A1"…"A99", then "B1"… (the WhatsApp listener's scheme since day one). */
export function refFor(n) {
  const letter = String.fromCharCode(65 + (Math.floor((n - 1) / 99) % 26));
  return `${letter}${((n - 1) % 99) + 1}`;
}

/** "B3" → 102; 0 for anything that isn't a ref. */
export function refNumber(ref) {
  const m = /^([A-Z])(\d{1,2})$/.exec(String(ref || '').toUpperCase());
  return m ? (m[1].charCodeAt(0) - 65) * 99 + Number(m[2]) : 0;
}

const COUNTER = 'task_ref_counter';
const counter = (db) => Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(COUNTER)?.value || 0);
const setCounter = (db, n) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(COUNTER, String(n));

/** Never hand out a ref at or below `n` (e.g. the WhatsApp listener's last one). */
export function seedTaskRefs(db, n) {
  if (Number(n) > counter(db)) setCounter(db, Number(n));
}

/** The WhatsApp listener's counter, read without touching its database. 0 if there isn't one. */
export function whatsappRefCounter(file) {
  if (!file || !fs.existsSync(file)) return 0;
  const wa = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Number(wa.prepare("SELECT value FROM meta WHERE key = 'ref_counter'").get()?.value || 0);
  } catch {
    return 0;
  } finally {
    wa.close();
  }
}

export function nextTaskRef(db) {
  return db.transaction(() => {
    const highest = Math.max(0, ...db.prepare('SELECT ref FROM tasks').all().map((t) => refNumber(t.ref)));
    const n = Math.max(counter(db), highest) + 1;
    setCounter(db, n);
    return refFor(n);
  }).immediate();
}

const fromRow = (r) =>
  r && {
    ref: r.ref,
    title: r.title,
    status: r.status,
    assignee: r.assignee,
    due: r.due,
    priority: r.priority,
    po: r.po,
    notes: r.notes,
    source: r.source,
    sourceChat: r.source_chat,
    sourceQuote: r.source_quote,
    createdAt: r.created_at,
    createdBy: r.created_by,
    doneAt: r.done_at,
  };

export const listTasks = (db) => db.prepare('SELECT * FROM tasks').all().map(fromRow);
export const getTask = (db, ref) => fromRow(db.prepare('SELECT * FROM tasks WHERE ref = ?').get(String(ref).toUpperCase()));
export const tasksForPo = (db, po) => db.prepare('SELECT * FROM tasks WHERE po = ? ORDER BY created_at DESC').all(po).map(fromRow);

/**
 * Inserts or replaces a task and logs it. `doneAt` follows the status: set when
 * a task first becomes done, cleared when it's reopened.
 */
export function saveTask(db, task, { actor, action = 'upsert' }) {
  const before = getTask(db, task.ref);
  const at = new Date().toISOString();
  const t = {
    ...task,
    createdAt: before?.createdAt || task.createdAt || at,
    createdBy: before?.createdBy || task.createdBy || actor,
    doneAt: task.status === 'done' ? before?.doneAt || task.doneAt || at : null,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (ref, title, status, assignee, due, priority, po, notes, source, source_chat, source_quote, created_at, created_by, updated_at, done_at)
       VALUES (@ref, @title, @status, @assignee, @due, @priority, @po, @notes, @source, @sourceChat, @sourceQuote, @createdAt, @createdBy, @at, @doneAt)
       ON CONFLICT(ref) DO UPDATE SET title = excluded.title, status = excluded.status, assignee = excluded.assignee, due = excluded.due,
         priority = excluded.priority, po = excluded.po, notes = excluded.notes, updated_at = excluded.updated_at, done_at = excluded.done_at`
    ).run({
      ref: t.ref,
      title: t.title,
      status: t.status,
      assignee: t.assignee ?? null,
      due: t.due ?? null,
      priority: t.priority ?? null,
      po: t.po ?? null,
      notes: t.notes ?? null,
      source: t.source || 'manual',
      sourceChat: t.sourceChat ?? null,
      sourceQuote: t.sourceQuote ?? null,
      createdAt: t.createdAt,
      createdBy: t.createdBy,
      at,
      doneAt: t.doneAt,
    });
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)').run(at, actor, before ? action : 'create', 'task', t.ref, JSON.stringify(getTask(db, t.ref)));
  })();
  return getTask(db, t.ref);
}

export function deleteTask(db, ref, { actor }) {
  const before = getTask(db, ref);
  if (!before) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM tasks WHERE ref = ?').run(before.ref);
    db.prepare('INSERT INTO audit_log (at, actor, action, entity, entity_id, data) VALUES (?, ?, ?, ?, ?, ?)').run(new Date().toISOString(), actor, 'delete', 'task', before.ref, JSON.stringify(before));
  })();
  return true;
}

/** Oldest first: [{ at, actor, action, task }]. */
export function taskHistory(db, ref) {
  return db
    .prepare("SELECT at, actor, action, data FROM audit_log WHERE entity = 'task' AND entity_id = ? ORDER BY id")
    .all(ref)
    .map((a) => ({ at: a.at, actor: a.actor, action: a.action, task: a.data ? JSON.parse(a.data) : null }));
}

/**
 * An approved WhatsApp candidate (a row from the listener's `candidates` table)
 * as a New task on the board, keeping its ref, chat and the message it came from.
 * Approving the same ref twice updates the one task rather than adding another.
 */
export function addWhatsAppTask(db, c, { actor = 'Ashar' } = {}) {
  const existing = getTask(db, c.ref);
  return saveTask(
    db,
    {
      ...existing,
      ref: String(c.ref).toUpperCase(),
      title: c.title,
      status: existing?.status || 'new',
      assignee: PEOPLE.includes(c.assignee) ? c.assignee : null,
      due: /^\d{4}-\d{2}-\d{2}$/.test(c.due_date || '') ? c.due_date : null,
      priority: PRIORITIES.includes(c.priority) ? c.priority : null,
      notes: c.notes || null,
      source: 'whatsapp',
      sourceChat: c.chat_label || null,
      sourceQuote: c.quote || null,
    },
    { actor, action: existing ? 'edit' : 'create' }
  );
}
