#!/usr/bin/env node
/**
 * Shows the landing-cost engine reproducing the sourcing sheet from raw
 * payments, invoices, courier bills and shipments.
 *
 *   npm run landing:check                         # every fixture in private/fixtures/landing
 *   npm run landing:check -- path/to/fixture.json
 *   npm run landing:check -- --show FBA19M4P6LZR:EGLS10-US   # the working behind one batch
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { checkFixture } from '../src/landing/golden.js';
import { fmt4 } from '../src/landing/money.js';

const args = process.argv.slice(2);
const showAt = args.indexOf('--show');
const show = showAt >= 0 ? args.splice(showAt, 2)[1] : null;

const dir = path.join(ROOT, 'private', 'fixtures', 'landing');
const files = args.length ? args : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) : [];
if (!files.length) {
  console.error('No fixtures found in private/fixtures/landing (they hold supplier pricing, so they are never committed).');
  process.exit(1);
}

const STATUS = { final: 'Final', count_pending: 'Awaiting count', estimated: 'Estimated', provisional: 'Deposit only', incomplete: 'Incomplete' };
const pad = (s, n) => String(s ?? '—').padEnd(n);
const lpad = (s, n) => String(s ?? '—').padStart(n);

let allOk = true;
for (const file of files) {
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const check = checkFixture(fixture);
  allOk &&= check.ok;

  console.log(`\n${path.basename(file)}\n`);
  console.log(`  ${pad('Product', 11)}${pad('Mkt', 4)}${pad('Shipment', 14)}${lpad('Units', 6)}  ${lpad('Product', 9)}${lpad('Delivery', 10)}${lpad('Landing', 10)}  ${pad('Status', 15)}${pad('', 3)}Sheet`);
  for (const row of check.rows) {
    const b = row.batch;
    const sym = b?.currency === 'USD' ? '$' : '£';
    const money = (v) => (v === null || v === undefined ? '—' : `${sym}${fmt4(v)}`);
    const est = b?.deliveryBasis === 'estimated' ? '*' : ' ';
    console.log(
      `  ${pad(b?.code ?? row.expected.product, 11)}${pad(b?.marketplace, 4)}${pad(row.expected.shipment, 14)}${lpad(b ? b.units.toString() : null, 6)}  ` +
        `${lpad(money(b?.productCost), 9)}${lpad(money(b?.deliveryCost), 9)}${est}${lpad(money(b?.landingCost), 10)}  ` +
        `${pad(STATUS[b?.status] ?? b?.status, 15)}${row.ok ? ' ✓ ' : ' ✗ '}${row.expected.sheet ?? ''}`
    );
    if (!row.ok) console.log(`      ${row.mismatches.join('; ')}`);
  }
  console.log('  * delivery estimated from an earlier shipment until the courier bill arrives');

  if (check.scenarios.length) {
    console.log('\n  What happens when Amazon reports counts:');
    for (const sc of check.scenarios) {
      const detail = sc.rows.map((r) => {
        const b = r.batch;
        const f = r.expected.landingCost ? 'landingCost' : 'productCost';
        return `${b?.code} ${f === 'landingCost' ? 'landing' : 'product'} ${fmt4(b?.[f])}`;
      });
      console.log(`  ${sc.ok ? '✓' : '✗'} ${sc.name}: ${detail.join(', ')}`);
      if (!sc.ok) console.log(`      ${sc.error || sc.rows.flatMap((r) => r.mismatches).join('; ')}`);
    }
  }

  const flagged = check.result.issues.filter((i) => i.severity !== 'info');
  if (flagged.length) {
    console.log('\n  Things the engine flags:');
    for (const i of flagged) console.log(`  ${i.severity === 'error' ? '✗' : '!'} ${i.message}`);
  }

  if (show) {
    const [shipment, product] = show.split(':');
    const b = check.result.batches.find((x) => x.shipment === shipment && (!product || x.product === product));
    if (!b) console.log(`\n  No batch ${show}`);
    else {
      console.log(`\n  ${b.code} ${b.marketplace} · ${b.shipment} · ${STATUS[b.status]}`);
      for (const step of b.working) console.log(`    ${pad(step.label, 24)}${step.text}`);
    }
  }
}

console.log(allOk ? '\nAll figures match the sheet.\n' : '\nSome figures do not match — see ✗ above.\n');
process.exit(allOk ? 0 : 1);
