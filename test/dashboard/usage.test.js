// AI usage: tokens and cost per Gemini call, priced on the day. Made-up numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLandingDb } from '../../src/landing/store.js';
import { createDashboard } from '../../src/dashboard/server.js';
import { costOf, usageFrom, recordUsage } from '../../src/ai/usage.js';

test('cost uses the price on the day: output and thinking at the output rate', () => {
  // 1M in + 1M out + 1M thinking: 0.75 + 2 × 3.75 in 2026, 1.50 + 2 × 7.50 from 2027.
  assert.equal(costOf({ model: 'gemini-3.8-flash', at: '2026-10-10T12:00:00Z', input: 1e6, output: 1e6, thinking: 1e6 }), '8.25');
  assert.equal(costOf({ model: 'gemini-3.8-flash', at: '2027-01-01T00:00:00Z', input: 1e6, output: 1e6, thinking: 1e6 }), '16.5');
  assert.equal(costOf({ model: 'gemini-3.8-flash', at: '2026-10-10', input: 130, output: 70 }), '0.00036');
  assert.equal(costOf({ model: 'some-other-model', at: '2026-10-10', input: 100 }), null);
});

test('token counts come from Gemini usageMetadata, with audio picked out', () => {
  const u = usageFrom({ usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 80, thoughtsTokenCount: 40, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 300 }, { modality: 'AUDIO', tokenCount: 600 }] } });
  assert.deepEqual(u, { input: 900, output: 80, thinking: 40, audio: 600 });
  assert.deepEqual(usageFrom({}), { input: 0, output: 0, thinking: 0, audio: 0 });
});

test('the AI usage page shows each call and the totals', async () => {
  const db = openLandingDb(':memory:');
  const at = new Date().toISOString();
  recordUsage(db, { at, job: 'tasks', detail: 'Supplier group · 3 msgs + 1 attachment', model: 'gemini-3.8-flash', input: 2000, output: 100, thinking: 300, audio: 1500 });
  recordUsage(db, { at, job: 'invoice', detail: 'Invoice PDF', model: 'gemini-3.8-flash', input: 4000, output: 500 });
  const server = createDashboard({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const page = await (await fetch(`http://127.0.0.1:${server.address().port}/usage`, { headers: { Cookie: 'actor=Ashar' } })).text();
    assert.match(page, /Supplier group · 3 msgs \+ 1 attachment/);
    assert.match(page, /1,500 audio/);
    assert.match(page, /Invoice read/);
    // (2000 + 4000) × 0.75 + (100 + 300 + 500) × 3.75 = 4500 + 3375 = 7875 per million → $0.0079
    assert.match(page, /\$0\.0079/);
    assert.match(page, /2 calls<br>6,000 in \/ 900 out/);
  } finally {
    server.close();
  }
});
