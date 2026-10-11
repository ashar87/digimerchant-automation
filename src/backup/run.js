/**
 * The nightly backup: an encrypted snapshot of the landing-cost database, plus
 * every attached document and invoice file, copied off the server to Backblaze B2.
 *
 * - db/landing-<stamp>.db.enc: one per night; the newest `keep` are kept, here and in B2.
 * - files/<name>.enc and invoices/<name>.enc: documents are named by their content
 *   hash and never change, so each is uploaded once.
 *
 * Everything is encrypted (AES-256-GCM, key from the passphrase) before it leaves
 * the server. The outcome is recorded (setting backup_last) for the Inbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptFile } from '../landing/backup.js';

export const LAST = 'backup_last';
export const STALE_AFTER_MS = 36 * 3600_000;

const note = (db, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(LAST, JSON.stringify(value));

export function lastBackup(db) {
  try {
    return JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(LAST)?.value || 'null');
  } catch {
    return null;
  }
}

export async function runBackup({ db, passphrase, localDir, keep = 30, folders = {}, b2 = null, now = new Date() }) {
  if (!passphrase) throw new Error('BACKUP_PASSPHRASE is not set');
  const report = { at: now.toISOString(), ok: false, snapshot: null, uploaded: 0, documents: 0, pruned: 0, offsite: !!b2 };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-backup-'));
  try {
    // 1. The database, consistent even while the dashboard and listener write to it.
    fs.mkdirSync(localDir, { recursive: true, mode: 0o700 });
    const raw = path.join(work, 'landing.db');
    await db.backup(raw);
    const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `landing-${stamp}.db.enc`;
    const local = path.join(localDir, name);
    encryptFile(raw, local, passphrase);
    report.snapshot = name;
    const kept = fs.readdirSync(localDir).filter((f) => /^landing-.*\.db\.enc$/.test(f)).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - keep))) fs.rmSync(path.join(localDir, old));

    if (b2) {
      await b2.upload(`db/${name}`, fs.readFileSync(local));
      report.uploaded++;
      const remote = (await b2.list('db/')).filter((f) => /^db\/landing-.*\.db\.enc$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      for (const old of remote.slice(0, Math.max(0, remote.length - keep))) {
        await b2.remove(old);
        report.pruned++;
      }

      // 2. Documents: only those not already there.
      for (const [prefix, dir] of Object.entries(folders)) {
        if (!dir || !fs.existsSync(dir)) continue;
        const there = new Set((await b2.list(`${prefix}/`)).map((f) => f.name));
        for (const file of fs.readdirSync(dir)) {
          const full = path.join(dir, file);
          if (!fs.statSync(full).isFile()) continue;
          report.documents++;
          const target = `${prefix}/${file}.enc`;
          if (there.has(target)) continue;
          const enc = path.join(work, `${file}.enc`);
          encryptFile(full, enc, passphrase);
          await b2.upload(target, fs.readFileSync(enc));
          fs.rmSync(enc);
          report.uploaded++;
        }
      }
    }
    report.ok = true;
    return report;
  } catch (err) {
    report.error = err.message;
    throw err;
  } finally {
    note(db, report);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Inbox lines: a backup that failed, or none for a day and a half. */
export function backupItems(last, { now = Date.now(), when = (iso) => iso, configured = true } = {}) {
  if (!configured) return [];
  if (!last) return [{ tone: 'error', title: 'No backup has run yet: the server holds the only copy of this data.', href: '/settings', count: true }];
  if (!last.ok) return [{ tone: 'error', title: `The backup on ${when(last.at)} failed: ${last.error || 'unknown error'}.`, href: '/settings', count: true }];
  if (now - Date.parse(last.at) > STALE_AFTER_MS) return [{ tone: 'error', title: `No backup since ${when(last.at)}.`, href: '/settings', count: true }];
  if (!last.offsite) return [{ tone: 'warning', title: 'Backups are kept on the server only. Set up Backblaze so a copy is kept somewhere else.', href: '/settings', count: true }];
  return [];
}
