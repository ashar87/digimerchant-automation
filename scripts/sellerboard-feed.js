#!/usr/bin/env node
/**
 * The Sellerboard cost feed.
 *
 *   npm run sellerboard:feed                     # show what Sellerboard would get, and what's held
 *   npm run sellerboard:feed -- --csv out.csv    # write it as CSV (for a manual upload)
 *   npm run sellerboard:feed -- --publish        # write the Google Sheet (needs GOOGLE_* in .env)
 */
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openLandingDb, loadLedger } from '../src/landing/store.js';
import { computeLandingCosts } from '../src/landing/engine.js';
import { buildFeed, toCsv } from '../src/sellerboard/feed.js';
import { createSheetsWriter, sheetsConfigured } from '../src/google/sheets.js';
import { publishFeed } from '../src/sellerboard/publish.js';

const args = process.argv.slice(2);
const csvAt = args.indexOf('--csv');
const db = openLandingDb(config.landingDbPath);
const ledger = loadLedger(db);
const feed = buildFeed(ledger, computeLandingCosts(ledger));

console.log(`${feed.rows.length} row(s) for Sellerboard, ${feed.held.length} held back.\n`);
for (const r of feed.rows) console.log(`  ${(r.sku || r.asin).padEnd(14)} ${r.marketplace.padEnd(13)} ${r.date} ${r.quantity.padStart(6)}  ${r.cost} ${r.currency}  ${r.shipment}  ${r.status}`);
if (feed.held.length) {
  console.log('\n  Held back:');
  for (const h of feed.held) console.log(`  ${`${h.code || h.product} ${h.marketplace} ${h.shipment}`.padEnd(32)} ${h.reason}`);
}

if (csvAt >= 0) {
  const out = args[csvAt + 1] || 'data/sellerboard-cogs.csv';
  fs.writeFileSync(out, toCsv(feed.rows), { mode: 0o600 });
  console.log(`\nWrote ${out}. It holds your unit costs: keep it private.`);
}
if (args.includes('--publish')) {
  if (!sheetsConfigured(config.sellerboard)) {
    console.log('\nGoogle Sheet not set up yet: add GOOGLE_SERVICE_ACCOUNT_FILE and SELLERBOARD_SHEET_ID to .env.');
    process.exit(0);
  }
  const r = await publishFeed({ db, writer: createSheetsWriter(config.sellerboard) });
  console.log(r.ok ? `\nGoogle Sheet updated: ${r.rows} row(s).` : `\n✗ ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}
