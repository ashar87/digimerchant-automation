#!/usr/bin/env node
/**
 * The Sellerboard cost feed.
 *
 *   npm run sellerboard:feed                         # show what each Sellerboard account would get, and what's held
 *   npm run sellerboard:feed -- --xlsx us out.xlsx   # one account's import file (uk-de or us), for a manual upload
 *   npm run sellerboard:feed -- --publish            # write each account's Google Sheet (needs GOOGLE_* in .env)
 *   npm run sellerboard:feed -- --entered FBA… SKU 3.57 [units] [dd/mm/yyyy]
 *                                                    # a batch already typed into Sellerboard: on the list as done, no card
 */
import fs from 'node:fs';
import { config } from '../src/config.js';
import { openLandingDb, loadLedger } from '../src/landing/store.js';
import { computeLandingCosts } from '../src/landing/engine.js';
import { ACCOUNTS, buildFeed, toXlsx } from '../src/sellerboard/feed.js';
import { loadCatalog } from '../src/sellerboard/catalog.js';
import { publishFeed, sheetWriters } from '../src/sellerboard/publish.js';
import { recordEntered, refreshSellerboardTasks } from '../src/sellerboard/tasks.js';

const args = process.argv.slice(2);
const xlsxAt = args.indexOf('--xlsx');
const enteredAt = args.indexOf('--entered');
const db = openLandingDb(config.landingDbPath);

if (enteredAt >= 0) {
  const [shipment, product, cost, units, date] = args.slice(enteredAt + 1);
  if (!shipment || !product || !cost) {
    console.log('--entered needs the shipment, the product (or SKU) and the cost typed in: --entered FBA… SKU 3.57 [units] [dd/mm/yyyy]');
    process.exit(1);
  }
  const t = recordEntered(db, { shipment, product, cost, units: units ? Number(units) : null, date: date || null, actor: 'Ashar' });
  console.log(`${t.sku} ${t.marketplace} ${t.shipment}: in Sellerboard at ${t.entered.cost} for ${t.entered.units} units from ${t.entered.date}; the dashboard has ${t.target.cost}.`);
  const queued = refreshSellerboardTasks(db);
  console.log(`List refreshed: ${queued} card(s) queued.`);
  process.exit(0);
}
const ledger = loadLedger(db);
const feed = buildFeed(ledger, computeLandingCosts(ledger), { catalog: loadCatalog(db) });

console.log(`${feed.rows.length} row(s) for Sellerboard, ${feed.held.length} held back.`);
for (const [account, a] of Object.entries(ACCOUNTS)) {
  const rows = feed.rows.filter((r) => r.account === account);
  console.log(`\n  ${a.label} account (${a.currency}): ${rows.length} row(s)`);
  for (const r of rows) console.log(`  ${(r.sku || r.asin).padEnd(14)} ${r.marketplace.padEnd(13)} ${r.date} ${r.quantity.padStart(6)}  ${r.cost} ${r.currency}  ${r.shipment}  ${r.status}`);
}
if (feed.held.length) {
  console.log('\n  Held back:');
  for (const h of feed.held) console.log(`  ${`${h.code || h.product} ${h.marketplace} ${h.shipment}`.padEnd(32)} ${h.reason}`);
}

if (xlsxAt >= 0) {
  const account = args[xlsxAt + 1];
  if (!ACCOUNTS[account]) {
    console.log(`\n--xlsx needs the account: ${Object.keys(ACCOUNTS).join(' or ')}`);
    process.exit(1);
  }
  const out = args[xlsxAt + 2] || `data/sellerboard-cogs-${account}.xlsx`;
  fs.writeFileSync(out, await toXlsx(feed.rows.filter((r) => r.account === account)), { mode: 0o600 });
  console.log(`\nWrote ${out}. It holds your unit costs: keep it private.`);
}
if (args.includes('--publish')) {
  const writers = sheetWriters(config.sellerboard);
  if (!Object.keys(writers).length) {
    console.log('\nGoogle Sheets not set up yet: add GOOGLE_SERVICE_ACCOUNT_FILE and SELLERBOARD_SHEET_ID_UK_DE / _US to .env.');
    process.exit(0);
  }
  const r = await publishFeed({ db, writers });
  for (const x of r.results) console.log(x.ok ? `\n${ACCOUNTS[x.account].label} sheet updated: ${x.rows} row(s).` : `\n✗ ${ACCOUNTS[x.account].label} sheet: ${x.error}`);
  process.exit(r.ok ? 0 : 1);
}
