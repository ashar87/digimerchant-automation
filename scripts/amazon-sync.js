#!/usr/bin/env node
/**
 * Pulls shipment status and received counts from Amazon into the landing-cost
 * records, and queues WhatsApp cards for what changed.
 *
 *   npm run amazon:sync                       # needs SPAPI_* in .env
 *   npm run amazon:sync -- --dry-run          # works on a copy; nothing saved or queued
 *   npm run amazon:sync -- --fixture file.json --dry-run   # recorded responses instead of Amazon
 *
 * Meant to run each morning (see deploy/digimerchant-amazon-sync.timer).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { openLandingDb } from '../src/landing/store.js';
import { createSpApi, spApiConfigured } from '../src/amazon/spapi.js';
import { recordedSpApi } from '../src/amazon/recorded.js';
import { syncAmazon } from '../src/amazon/sync.js';
import { unsent } from '../src/notify/outbox.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fixtureAt = args.indexOf('--fixture');
const fixture = fixtureAt >= 0 ? args[fixtureAt + 1] : null;

let client;
if (fixture) client = recordedSpApi(JSON.parse(fs.readFileSync(fixture, 'utf8')));
else if (spApiConfigured(config.spapi)) client = createSpApi(config.spapi);
else {
  console.log('Amazon API not set up yet: add SPAPI_LWA_CLIENT_ID, SPAPI_LWA_CLIENT_SECRET and a SPAPI_REFRESH_TOKEN_EU / _NA to .env.');
  process.exit(0);
}

const live = openLandingDb(config.landingDbPath);
// A dry run works on a throwaway copy, so nothing is saved and no cards are queued.
let db = live;
let copy = null;
if (dryRun) {
  copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'landing-dry-')), 'landing.db');
  await live.backup(copy);
  db = openLandingDb(copy);
}
process.on('exit', () => copy && fs.rmSync(path.dirname(copy), { recursive: true, force: true }));

const report = await syncAmazon({ db, client });
console.log(`${dryRun ? 'Dry run — nothing saved. ' : ''}Checked ${report.checked} shipment(s) in ${client.marketplaces().join(', ')}.`);
if (report.created.length) console.log(`  New: ${report.created.join(', ')}`);
if (report.updated.length) console.log(`  Updated: ${report.updated.join(', ')}`);
if (report.linked.length) console.log(`  Linked by PO in the name: ${report.linked.join(', ')}`);
if (report.unmapped.length) console.log(`  SKUs not in the product list: ${report.unmapped.join(', ')}`);
for (const e of report.errors) console.log(`  ✗ ${e}`);
const cards = unsent(db, 50);
if (cards.length) {
  console.log(`\n  ${dryRun ? 'Would queue' : 'Queued'} for WhatsApp:\n`);
  for (const c of cards) console.log(`${c.text.replace(/^/gm, '    ')}\n`);
}
process.exit(report.errors.length ? 1 : 0);
