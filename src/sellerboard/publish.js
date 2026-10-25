import { loadLedger } from '../landing/store.js';
import { computeLandingCosts } from '../landing/engine.js';
import { createSheetsWriter, sheetsConfigured } from '../google/sheets.js';
import { ACCOUNTS, buildFeed, feedValues } from './feed.js';

/** A Sheets writer for each Sellerboard account whose sheet is configured. */
export function sheetWriters(cfg = {}) {
  const writers = {};
  for (const account of Object.keys(ACCOUNTS)) {
    const c = { keyFile: cfg.keyFile, sheetId: cfg.sheetIds?.[account], tab: cfg.tab };
    if (sheetsConfigured(c)) writers[account] = createSheetsWriter(c);
  }
  return writers;
}

/**
 * Writes each account's feed to the Google Sheet that account's Sellerboard
 * reads. Each run replaces the whole tab, so a corrected cost simply appears in
 * its row the next day.
 */
export async function publishFeed({ db, writers, now = new Date() }) {
  const ledger = loadLedger(db);
  const result = computeLandingCosts(ledger);
  const results = [];
  for (const [account, writer] of Object.entries(writers)) {
    const feed = buildFeed(ledger, result, { account });
    const kind = `sellerboard:${account}`;
    try {
      const out = await writer.replaceTab(feedValues(feed.rows));
      db.prepare('INSERT INTO sync_runs (kind, at, ok, summary) VALUES (?, ?, 1, ?)').run(kind, now.toISOString(), JSON.stringify({ rows: out.rows, held: feed.held.length }));
      results.push({ account, ok: true, rows: out.rows });
    } catch (err) {
      db.prepare('INSERT INTO sync_runs (kind, at, ok, summary) VALUES (?, ?, 0, ?)').run(kind, now.toISOString(), JSON.stringify({ errors: [err.message] }));
      results.push({ account, ok: false, error: err.message });
    }
  }
  return { ok: results.every((r) => r.ok), results };
}
