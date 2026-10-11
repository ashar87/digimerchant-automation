#!/usr/bin/env node
/**
 * Nightly encrypted backup of the landing-cost records (see src/backup/run.js):
 * the database, plus the attached documents and invoice files, copied to
 * Backblaze B2 when B2_* are set. Run by deploy/digimerchant-landing-backup.timer.
 *
 *   npm run landing:backup                                   # back up now
 *   npm run landing:backup -- --verify                       # fetch the newest copy from B2 and check it opens
 *   npm run landing:backup -- --restore file.db.enc out.db   # decrypt a snapshot to out.db
 *   npm run landing:backup -- --restore-latest out.db        # the newest snapshot in B2, decrypted to out.db
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import { openLandingDb } from '../src/landing/store.js';
import { decryptFile } from '../src/landing/backup.js';
import { runBackup } from '../src/backup/run.js';
import { createB2, b2Configured } from '../src/backup/b2.js';
import { FILES_DIR } from '../src/files/attachments.js';
import { INVOICE_DIR } from '../src/invoices/intake.js';

const { passphrase, dir, keep } = config.backup;
if (!passphrase) {
  console.error('Set BACKUP_PASSPHRASE first (and keep a copy of it somewhere other than this server).');
  process.exit(1);
}
const b2 = b2Configured(config.backup.b2) ? createB2(config.backup.b2) : null;
const args = process.argv.slice(2);

async function latestFromB2(to) {
  if (!b2) throw new Error('Backblaze isn’t set up (B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET)');
  const snaps = (await b2.list('db/')).map((f) => f.name).filter((n) => n.endsWith('.db.enc')).sort();
  if (!snaps.length) throw new Error('No snapshots in Backblaze yet');
  const name = snaps.at(-1);
  const enc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-')), 'snap.enc');
  fs.writeFileSync(enc, await b2.download(name), { mode: 0o600 });
  decryptFile(enc, to, passphrase);
  fs.rmSync(path.dirname(enc), { recursive: true, force: true });
  return name;
}

if (args[0] === '--restore') {
  const [, from, to] = args;
  if (!from || !to || fs.existsSync(to)) {
    console.error('Usage: npm run landing:backup -- --restore <file.db.enc> <new-file.db>  (won’t overwrite an existing file)');
    process.exit(1);
  }
  decryptFile(from, to, passphrase);
  console.log(`Restored to ${to}. Check it, then move it into place with the dashboard stopped.`);
} else if (args[0] === '--restore-latest') {
  const to = args[1];
  if (!to || fs.existsSync(to)) {
    console.error('Usage: npm run landing:backup -- --restore-latest <new-file.db>  (won’t overwrite an existing file)');
    process.exit(1);
  }
  const name = await latestFromB2(to);
  console.log(`Restored ${name} from Backblaze to ${to}. Check it, then move it into place with the dashboard stopped.`);
} else if (args[0] === '--verify') {
  // Proves a backup can actually be brought back: download, decrypt, open, count.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-')), 'landing.db');
  try {
    const name = await latestFromB2(out);
    const db = new Database(out, { readonly: true });
    const count = (t) => db.prepare(`SELECT count(*) n FROM ${t}`).get().n;
    console.log(`${name} restores: integrity ${db.pragma('integrity_check', { simple: true })}; ${count('orders')} orders, ${count('invoices')} invoices, ${count('payments')} payments, ${count('shipments')} shipments, ${count('tasks')} tasks, ${count('attachments')} documents.`);
    const docs = (await b2.list('files/')).length + (await b2.list('invoices/')).length;
    console.log(`${docs} document file(s) in Backblaze.`);
    db.close();
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
} else {
  const report = await runBackup({ db: openLandingDb(config.landingDbPath), passphrase, localDir: dir, keep, b2, folders: { files: FILES_DIR, invoices: INVOICE_DIR } });
  console.log(`Backed up ${report.snapshot}${b2 ? `: ${report.uploaded} file(s) sent to Backblaze, ${report.documents} document(s) covered, ${report.pruned} old snapshot(s) removed there` : ' (on this server only: Backblaze isn’t set up)'}.`);
}
