#!/usr/bin/env node
/**
 * Imports orders, payments, courier bills and shipments into the landing-cost
 * database as drafts. Every imported order lands in the dashboard Inbox as
 * "needs review" until someone checks it against the sheet.
 *
 *   npm run landing:import -- private/import/open-orders.json            # writes data/landing.db
 *   npm run landing:import -- private/import/open-orders.json --dry-run  # shows what would happen
 *
 * The file is read-only input (the sheet itself is never touched). Orders
 * someone has already marked checked are left alone unless --force is given.
 */
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openLandingDb, saveLedger, loadLedger } from '../src/landing/store.js';
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
const incoming = structuredClone(input.ledger || input);
const db = openLandingDb(dryRun ? ':memory:' : dbPath);
const current = loadLedger(db);

const reviewed = new Set(current.orders.filter((o) => o.review === 'reviewed').map((o) => o.po));
const skipped = [];
if (!force) {
  incoming.orders = (incoming.orders || []).filter((o) => {
    if (reviewed.has(o.po)) skipped.push(o.po);
    return !reviewed.has(o.po);
  });
}
for (const o of incoming.orders || []) o.review = 'needs_review';

// Validate before writing: a broken import should fail whole, not half-land.
const preview = computeLandingCosts(mergeForPreview(current, incoming));
const errors = preview.issues.filter((i) => i.severity === 'error');

saveLedger(db, incoming, { actor: 'import' });
const result = computeLandingCosts(loadLedger(db));

console.log(`${dryRun ? 'Dry run — nothing written.' : `Imported into ${dbPath}.`}`);
console.log(`  ${incoming.orders?.length || 0} orders (marked “needs review”), ${incoming.payments?.length || 0} payments, ${incoming.courierBills?.length || 0} courier bills, ${incoming.shipments?.length || 0} shipments, ${incoming.products?.length || 0} products`);
if (skipped.length) console.log(`  Left alone (already checked): ${skipped.join(', ')}. Use --force to overwrite.`);
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
if (errors.length) console.log(`\n  ${errors.length} error(s) above stop those costs being worked out until fixed.`);
console.log(dryRun ? '' : '\n  Open the dashboard (npm run dashboard) and check each order in the Inbox.\n');

function mergeForPreview(a, b) {
  const merge = (x = [], y = [], key) => [...x.filter((r) => !y.some((s) => s[key] === r[key])), ...y];
  return {
    products: merge(a.products, b.products, 'id'),
    orders: merge(a.orders, b.orders, 'po'),
    payments: merge(a.payments, b.payments, 'id'),
    courierBills: merge(a.courierBills, b.courierBills, 'id'),
    shipments: merge(a.shipments, b.shipments, 'id'),
  };
}
