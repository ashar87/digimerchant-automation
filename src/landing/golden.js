/**
 * Checks the engine against a fixture of real orders: raw records in,
 * the sheet's figures out. The ledger goes through SQLite first, so the
 * data model is tested along with the arithmetic.
 */
import { computeLandingCosts } from './engine.js';
import { openLandingDb, saveLedger, loadLedger } from './store.js';
import { D } from './money.js';

const FIELDS = ['productCost', 'deliveryCost', 'landingCost'];

export function checkFixture(fixture) {
  const ledger = roundTrip(fixture.ledger);
  const result = computeLandingCosts(ledger);

  const rows = (fixture.expected || []).map((e) => compare(e, result));

  const issues = (fixture.expectedIssues || []).map((e) => {
    const found = result.issues.find((i) => i.code === e.code && i.ref === e.ref && (!e.contains || i.message.includes(e.contains)));
    return { expected: e, found: found || null, ok: !!found };
  });

  const scenarios = (fixture.scenarios || []).map((sc) => {
    const changed = structuredClone(ledger);
    const s = changed.shipments.find((x) => x.id === sc.set.shipment);
    if (!s) return { name: sc.name, rows: [], ok: false, error: `no shipment ${sc.set.shipment}` };
    if (sc.set.status) s.status = sc.set.status;
    for (const [product, n] of Object.entries(sc.set.received || {})) {
      const item = s.items.find((i) => i.product === product);
      if (item) item.received = n;
    }
    const r = computeLandingCosts(changed);
    const scRows = sc.expect.map((e) => compare(e, r));
    return { name: sc.name, rows: scRows, ok: scRows.every((x) => x.ok) };
  });

  const ok = rows.every((r) => r.ok) && issues.every((i) => i.ok) && scenarios.every((s) => s.ok);
  return { ok, rows, issues, scenarios, result };
}

function roundTrip(ledger) {
  const db = openLandingDb(':memory:');
  try {
    saveLedger(db, ledger, { actor: 'golden' });
    return loadLedger(db);
  } finally {
    db.close();
  }
}

function compare(expected, result) {
  const batch = result.batches.find((b) => b.shipment === expected.shipment && b.product === expected.product);
  const places = expected.places ?? 4;
  const show = (v) => (v === null || v === undefined ? null : D(v).toFixed(places));
  const actual = batch ? Object.fromEntries(FIELDS.map((f) => [f, show(batch[f])])) : null;
  const mismatches = [];
  if (!batch) mismatches.push('batch missing');
  else {
    for (const f of FIELDS) if (expected[f] !== undefined && actual[f] !== expected[f]) mismatches.push(`${f} ${actual[f]} ≠ ${expected[f]}`);
    if (expected.status && batch.status !== expected.status) mismatches.push(`status ${batch.status} ≠ ${expected.status}`);
  }
  return { expected, batch, actual, ok: mismatches.length === 0, mismatches };
}
