#!/usr/bin/env node
/**
 * Renames courier bills by prefix, everywhere they're referred to: the bill and
 * its lines, the payments that paid it, its documents, the bill draft it came
 * from, its change history, and Inbox checks dismissed by message.
 *
 *   node scripts/rename-bills.js ANNIE- BILL- --dry-run   # what would change
 *   node scripts/rename-bills.js ANNIE- BILL-             # do it (one transaction)
 *
 * Landing costs are computed before and after; if they differ, nothing is saved.
 */
import { config } from '../src/config.js';
import { openLandingDb, loadLedger } from '../src/landing/store.js';
import { computeLandingCosts } from '../src/landing/engine.js';

const [from, to, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
if (!from || !to) {
  console.log('usage: node scripts/rename-bills.js OLD-PREFIX NEW-PREFIX [--dry-run]');
  process.exit(1);
}

function renameBills(db, from, to) {
  const ids = db.prepare('SELECT id FROM courier_bills WHERE id LIKE ? ORDER BY length(id) DESC').all(`${from}%`).map((r) => r.id);
  const map = new Map(ids.map((id) => [id, to + id.slice(from.length)]));
  const taken = new Set(db.prepare('SELECT id FROM courier_bills').all().map((r) => r.id));
  for (const n of map.values()) if (taken.has(n)) throw new Error(`${n} already exists`);
  // Longest first, so no name is replaced inside a longer one.
  const swap = (text) => [...map].reduce((t, [a, b]) => t.split(a).join(b), text);
  const counts = {};
  const count = (what, n) => (counts[what] = (counts[what] || 0) + n);

  db.pragma('defer_foreign_keys = ON');
  for (const [a, b] of map) {
    count('bills', db.prepare('UPDATE courier_bills SET id = ? WHERE id = ?').run(b, a).changes);
    count('bill lines', db.prepare('UPDATE courier_bill_lines SET bill_id = ? WHERE bill_id = ?').run(b, a).changes);
    count('payment rows', db.prepare("UPDATE payment_allocations SET target = ? WHERE type = 'bill' AND target = ?").run(b, a).changes);
    count('documents', db.prepare("UPDATE attachments SET entity_id = ? WHERE entity = 'courier_bill' AND entity_id = ?").run(b, a).changes);
    count('bill drafts', db.prepare('UPDATE bill_drafts SET saved_as = ? WHERE saved_as = ?').run(b, a).changes);
    count('history entries', db.prepare("UPDATE audit_log SET entity_id = ? WHERE entity = 'courier_bill' AND entity_id = ?").run(b, a).changes);
  }
  const like = `%${from}%`;
  for (const row of db.prepare('SELECT id, data FROM audit_log WHERE data LIKE ?').all(like)) {
    count('history records', db.prepare('UPDATE audit_log SET data = ? WHERE id = ?').run(swap(row.data), row.id).changes);
  }
  for (const row of db.prepare('SELECT key, value FROM settings WHERE value LIKE ?').all(like)) {
    count(`setting ${row.key}`, db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(swap(row.value), row.key).changes);
  }
  return { map, counts };
}

const db = openLandingDb(config.landingDbPath);
const snapshot = (ledger) => {
  const r = computeLandingCosts(ledger);
  return JSON.stringify(r.batches.map((b) => [b.shipment, b.product, String(b.landingCost), String(b.deliveryCost)]).sort());
};
const before = snapshot(loadLedger(db));
const run = db.transaction(() => {
  const out = renameBills(db, from, to);
  const after = snapshot(loadLedger(db));
  if (after !== before) throw new Error('Landing costs changed after renaming; nothing saved.');
  if (dryRun) throw Object.assign(new Error('dry run'), { out });
  return out;
});

let out;
try {
  out = run();
} catch (err) {
  if (err.message !== 'dry run') {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
  out = err.out;
}
console.log(`${dryRun ? 'Dry run, nothing saved. Would rename' : 'Renamed'} ${out.map.size} bill(s):`);
for (const [a, b] of out.map) console.log(`  ${a} → ${b}`);
console.log(`Updated: ${Object.entries(out.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
console.log('Landing costs: identical before and after ✓');
