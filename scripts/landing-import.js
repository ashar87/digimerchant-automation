#!/usr/bin/env node
/**
 * Imports orders, payments, courier bills and shipments into the landing-cost
 * database as drafts. Every imported order lands in the dashboard Inbox as
 * "needs review" until someone checks it against the sheet.
 *
 *   npm run landing:import -- private/import/open-orders.json            # writes data/landing.db
 *   npm run landing:import -- private/import/open-orders.json --dry-run  # shows what would happen
 *
 * The file is read-only input (the sheet itself is never touched). Running it
 * again only replaces records nobody has touched since the last import: anything
 * edited on the dashboard, updated by the Amazon sync, or marked checked is kept,
 * unless --force is given.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { openLandingDb, loadLedger } from '../src/landing/store.js';
import { importLedger } from '../src/landing/importer.js';
import { computeLandingCosts } from '../src/landing/engine.js';
import { fmt4 } from '../src/landing/money.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const dryRun = flag('--dry-run');
const force = flag('--force');
const dbPath = option('--db') || config.landingDbPath;
const file = args[0];
if (!file) {
  console.error('Usage: npm run landing:import -- <file.json> [--dry-run] [--force] [--db path]');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(file, 'utf8'));
let db = openLandingDb(dbPath);
if (dryRun) {
  // A dry run works on a throwaway copy of the real database, so it shows what would change.
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'landing-import-')), 'landing.db');
  await db.backup(copy);
  db = openLandingDb(copy);
  process.on('exit', () => fs.rmSync(path.dirname(copy), { recursive: true, force: true }));
}
const report = importLedger(db, input, { force });
const result = computeLandingCosts(loadLedger(db));

const NAMES = { orders: 'orders', payments: 'payments', courierBills: 'courier bills', shipments: 'shipments', products: 'products' };
const line = (what) => Object.entries(report[what]).filter(([, ids]) => ids.length).map(([k, ids]) => `${ids.length} ${NAMES[k]}`).join(', ') || 'nothing';
console.log(`${dryRun ? 'Dry run — nothing written.' : `Imported into ${dbPath}.`}`);
console.log(`  Added: ${line('added')}`);
console.log(`  Replaced (untouched since the last import): ${line('replaced')}`);
console.log(`  Kept as they are (edited, synced or checked since): ${line('kept')}${force ? '' : '. Use --force to overwrite them.'}`);
console.log('  Imported orders are marked “needs review” until checked on the dashboard.');
console.log('\n  Batch                          Product   Delivery   Landing   Status');
for (const b of result.batches) {
  const sym = b.currency === 'USD' ? '$' : '£';
  const m = (v) => (v === null ? '—' : sym + fmt4(v));
  console.log(`  ${`${b.code || b.product} ${b.marketplace} ${b.shipment}`.padEnd(31)}${m(b.productCost).padStart(9)}${m(b.deliveryCost).padStart(11)}${b.deliveryBasis === 'estimated' ? '*' : ' '}${m(b.landingCost).padStart(9)}   ${b.status}`);
}
const flagged = result.issues.filter((i) => i.severity !== 'info');
if (flagged.length) {
  console.log('\n  To look at:');
  for (const i of flagged) console.log(`  ${i.severity === 'error' ? '✗' : '!'} ${i.message}`);
}
const errors = result.issues.filter((i) => i.severity === 'error');
if (errors.length) console.log(`\n  ${errors.length} error(s) above stop those costs being worked out until fixed.`);
console.log(dryRun ? '' : '\n  Open the dashboard (npm run dashboard) and check each order in the Inbox.\n');
