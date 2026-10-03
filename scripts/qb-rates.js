#!/usr/bin/env node
/**
 * Fills in the QuickBooks exchange rate on payments that need one (USD or EUR
 * towards a UK or DE order, no GBP amount). Exact-day rates only.
 *
 *   npm run qb:rates
 */
import { config } from '../src/config.js';
import { openLandingDb } from '../src/landing/store.js';
import { qboConfigured, qboFromConfig } from '../src/quickbooks/client.js';
import { fillRates } from '../src/quickbooks/rates.js';

if (!qboConfigured(config.qbo)) {
  console.log('QuickBooks not set up yet: add QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REALM_ID and QBO_REFRESH_TOKEN to .env.');
  process.exit(0);
}
const db = openLandingDb(config.landingDbPath);
const r = await fillRates({ db, qbo: qboFromConfig(db, config.qbo) });
for (const f of r.found) console.log(`  ${f.payment}: ${f.rate}`);
if (r.pending.length) console.log(`  Pending (no rate for that day yet): ${r.pending.join(', ')}`);
for (const f of r.failed) console.log(`  ✗ ${f.payment}: ${f.error}`);
console.log(`${r.found.length} filled, ${r.pending.length} pending, ${r.failed.length} failed.`);
process.exit(r.failed.length ? 1 : 0);
