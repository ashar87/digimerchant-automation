// Real orders from the sourcing sheet. The fixtures hold supplier pricing, so
// they live in private/ (never committed); without them this test is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../src/config.js';
import { checkFixture } from '../../src/landing/golden.js';

const dir = path.join(ROOT, 'private', 'fixtures', 'landing');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

if (!files.length) {
  test('golden fixtures from the sourcing sheet', { skip: 'no fixtures in private/fixtures/landing' }, () => {});
}

for (const file of files) {
  const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const check = checkFixture(fixture);

  for (const row of check.rows) {
    test(`${file}: ${row.expected.shipment} ${row.expected.product}`, () => {
      assert.ok(row.ok, row.mismatches.join('; '));
    });
  }
  for (const i of check.issues) {
    test(`${file}: flags ${i.expected.code} on ${i.expected.ref}`, () => assert.ok(i.ok));
  }
  for (const sc of check.scenarios) {
    test(`${file}: ${sc.name}`, () => {
      assert.ok(sc.ok, sc.error || sc.rows.flatMap((r) => r.mismatches).join('; '));
    });
  }
}
