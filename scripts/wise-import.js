#!/usr/bin/env node
/**
 * Reads recent Wise transfers so they can be recorded as payments on the
 * dashboard (Payments → From Wise).
 *
 *   npm run wise:import                 # last 30 days
 *   npm run wise:import -- --days 90
 */
import { config } from '../src/config.js';
import { openLandingDb } from '../src/landing/store.js';
import { createWise, wiseConfigured } from '../src/wise/client.js';
import { saveTransfers, unrecordedTransfers } from '../src/wise/import.js';

if (!wiseConfigured(config.wise)) {
  console.log('Wise not set up yet: add WISE_API_TOKEN to .env.');
  process.exit(0);
}
const daysAt = process.argv.indexOf('--days');
const days = daysAt >= 0 ? Number(process.argv[daysAt + 1]) : 30;
const db = openLandingDb(config.landingDbPath);
const to = new Date();
const from = new Date(to.getTime() - days * 86400_000);
const transfers = await createWise(config.wise).transfers({ from: from.toISOString(), to: to.toISOString() });
const saved = saveTransfers(db, transfers);
console.log(`Read ${transfers.length} transfer(s), kept ${saved}. ${unrecordedTransfers(db).length} waiting to be recorded as payments on the dashboard.`);
