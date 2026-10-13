#!/usr/bin/env node
/**
 * Fills in products' Seller SKUs from the shipments already on file: asks Amazon
 * (read-only) what each shipment contained and records the SKU it used for each
 * product that has none. The daily sync does the same for shipments it checks.
 *
 *   node scripts/learn-skus.js            # show what would be filled in
 *   node scripts/learn-skus.js --save     # and save it
 */
import { config } from '../src/config.js';
import { openLandingDb, loadLedger } from '../src/landing/store.js';
import { createSpApi, spApiConfigured } from '../src/amazon/spapi.js';
import { mergeShipment, saveLearnedSkus } from '../src/amazon/sync.js';

if (!spApiConfigured(config.spapi)) {
  console.error('Amazon API not set up.');
  process.exit(1);
}
const save = process.argv.includes('--save');
const client = createSpApi(config.spapi);
const db = openLandingDb(config.landingDbPath);
const ledger = loadLedger(db);
const learned = new Map();
const today = new Date().toISOString().slice(0, 10);

for (const s of ledger.shipments) {
  try {
    const items = await client.getShipmentItems(s.marketplace, s.id);
    const merged = mergeShipment({ existing: s, amazon: { ShipmentId: s.id, ShipmentStatus: s.status, ShipmentName: s.name }, items, marketplace: s.marketplace, ledger, today });
    for (const l of merged.learned) (learned.get(l.product) || learned.set(l.product, new Set()).get(l.product)).add(l.sku);
  } catch (err) {
    console.warn(`${s.id}: ${err.message}`);
  }
}

for (const [product, skus] of [...learned].sort()) console.log(`${product.padEnd(12)} ${[...skus].join(' / ')}${skus.size > 1 ? '   (more than one: left for you to choose)' : ''}`);
if (save) console.log(`Saved: ${saveLearnedSkus(db, learned, { actor: 'amazon-sync' }).join(', ') || 'nothing new'}`);
else console.log('\nNothing saved. Run with --save to fill these in.');
