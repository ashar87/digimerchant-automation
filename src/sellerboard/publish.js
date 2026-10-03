import { loadLedger } from '../landing/store.js';
import { computeLandingCosts } from '../landing/engine.js';
import { buildFeed, feedValues } from './feed.js';

/**
 * Writes the feed to the Google Sheet Sellerboard reads. Each run replaces the
 * whole tab, so a corrected cost simply appears in its row the next day.
 */
export async function publishFeed({ db, writer, now = new Date() }) {
  const feed = buildFeed(loadLedger(db), computeLandingCosts(loadLedger(db)));
  try {
    const out = await writer.replaceTab(feedValues(feed.rows));
    db.prepare("INSERT INTO sync_runs (kind, at, ok, summary) VALUES ('sellerboard', ?, 1, ?)").run(now.toISOString(), JSON.stringify({ rows: out.rows, held: feed.held.length }));
    return { ok: true, rows: out.rows, held: feed.held.length };
  } catch (err) {
    db.prepare("INSERT INTO sync_runs (kind, at, ok, summary) VALUES ('sellerboard', ?, 0, ?)").run(now.toISOString(), JSON.stringify({ errors: [err.message] }));
    return { ok: false, error: err.message };
  }
}
