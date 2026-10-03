#!/usr/bin/env node
/**
 * Encrypted snapshot of the landing-cost database. This becomes the record of
 * what every unit cost, so it is copied every night and kept off the server.
 *
 *   npm run landing:backup                                  # writes data/backups/landing-<date>.db.enc
 *   npm run landing:backup -- --restore file.db.enc out.db  # decrypts a snapshot to out.db
 *
 * AES-256-GCM with a key derived (scrypt) from BACKUP_PASSPHRASE. Keeps the
 * newest BACKUP_KEEP snapshots.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { openLandingDb } from '../src/landing/store.js';
import { encryptFile, decryptFile } from '../src/landing/backup.js';

const { passphrase, dir, keep } = config.backup;
if (!passphrase) {
  console.error('Set BACKUP_PASSPHRASE in .env first (and keep a copy of it somewhere other than this server).');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === '--restore') {
  const [, from, to] = args;
  if (!from || !to || fs.existsSync(to)) {
    console.error('Usage: npm run landing:backup -- --restore <file.db.enc> <new-file.db>  (won’t overwrite an existing file)');
    process.exit(1);
  }
  decryptFile(from, to, passphrase);
  console.log(`Restored to ${to}. Check it, then move it into place with the dashboard stopped.`);
  process.exit(0);
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'landing-backup-')), 'landing.db');
try {
  await openLandingDb(config.landingDbPath).backup(tmp);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const out = path.join(dir, `landing-${stamp}.db.enc`);
  encryptFile(tmp, out, passphrase);
  const all = fs.readdirSync(dir).filter((f) => /^landing-.*\.db\.enc$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old));
  console.log(`Backed up to ${out} (${Math.min(all.length, keep)} kept).`);
} finally {
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
}
