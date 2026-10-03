// Wise import and QuickBooks rates against fake APIs. Made-up figures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWise } from '../../src/wise/client.js';
import { saveTransfers, unrecordedTransfers, paymentFromTransfer } from '../../src/wise/import.js';
import { createQbo, qboFromConfig } from '../../src/quickbooks/client.js';
import { fillRates, paymentsNeedingRate } from '../../src/quickbooks/rates.js';
import { openLandingDb, saveLedger, loadLedger } from '../../src/landing/store.js';
import { computeLandingCosts } from '../../src/landing/engine.js';
import { fmt4 } from '../../src/landing/money.js';

const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('Wise: finds the business profile and pages through transfers', async () => {
  const seen = [];
  const fetch = async (url) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    if (u.pathname === '/v1/profiles') return respond([{ id: 1, type: 'PERSONAL' }, { id: 2, type: 'BUSINESS' }]);
    const offset = Number(u.searchParams.get('offset'));
    return respond(offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: i, created: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` })) : [{ id: 999, created: '2026-01-30' }]);
  };
  const transfers = await createWise({ token: 't', fetch }).transfers({ from: '2026-01-01', to: '2026-02-01' });
  assert.equal(transfers.length, 101);
  assert.ok(seen.some((s) => s.includes('profile=2') && s.includes('offset=100')));
});

test('Wise: a transfer becomes a payment suggestion, PO and part read from the reference', () => {
  const p = paymentFromTransfer({ id: 'w1', created: '2026-03-04 10:00:00', reference: 'PO-020 30%', source_currency: 'GBP', source_value: '750', target_currency: 'USD', target_value: '1000' });
  assert.deepEqual({ date: p.date, gbp: p.gbp, usd: p.usd, funding: p.funding }, { date: '2026-03-04', gbp: '750', usd: '1000', funding: 'GBP' });
  assert.deepEqual(p.allocation, { type: 'order', target: 'PO-020', part: 'deposit', usd: '1000', rmb: null });
  const rmb = paymentFromTransfer({ id: 'w2', created: '2026-03-05', reference: 'po-021 balance', source_currency: 'GBP', source_value: '500', target_currency: 'CNY', target_value: '4600' });
  assert.equal(rmb.funding, 'GBP straight to RMB');
  assert.deepEqual(rmb.allocation, { type: 'order', target: 'PO-021', part: 'balance', usd: undefined, rmb: '4600' });
});

test('Wise: cancelled transfers are never offered', () => {
  const db = openLandingDb(':memory:');
  saveTransfers(db, [
    { id: 1, created: '2026-01-01', status: 'outgoing_payment_sent', sourceCurrency: 'USD', sourceValue: 10, targetCurrency: 'USD', targetValue: 10 },
    { id: 2, created: '2026-01-02', status: 'cancelled', sourceCurrency: 'USD', sourceValue: 20, targetCurrency: 'USD', targetValue: 20 },
  ]);
  assert.deepEqual(unrecordedTransfers(db).map((t) => t.id), ['1']);
});

function qboFake({ asOf, rate = 0.75 }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth.platform.intuit.com')) return respond({ access_token: 'q-tok', refresh_token: `rotated-${calls.length}`, expires_in: 3600 });
    const date = new URL(url).searchParams.get('asofdate');
    return respond({ ExchangeRate: { SourceCurrencyCode: 'USD', TargetCurrencyCode: 'GBP', Rate: rate, AsOfDate: asOf ?? date } });
  };
  return { fetch, calls };
}

test('QuickBooks: an exact-day rate is used; another day’s rate is not', async () => {
  let refresh = 'first';
  const exact = qboFake({});
  const qbo = createQbo({ clientId: 'c', clientSecret: 's', realmId: '123', loadRefreshToken: () => refresh, saveRefreshToken: (t) => (refresh = t), fetch: exact.fetch });
  assert.deepEqual(await qbo.exchangeRate('USD', '2026-03-04'), { rate: '0.75', asOf: '2026-03-04', target: 'GBP' });
  assert.equal(refresh, 'rotated-1'); // the rotated token is kept
  assert.match(exact.calls[0].init.headers.Authorization, /^Basic /);
  assert.match(exact.calls[1].url, /company\/123\/exchangerate\?sourcecurrencycode=USD&asofdate=2026-03-04/);

  const stale = qboFake({ asOf: '2026-03-03' });
  const qbo2 = createQbo({ clientId: 'c', clientSecret: 's', realmId: '123', loadRefreshToken: () => 'x', saveRefreshToken: () => {}, fetch: stale.fetch });
  assert.equal((await qbo2.exchangeRate('USD', '2026-03-04')).rate, null);
});

test('QuickBooks: rates fill only the payments that need one, and the cost follows', async () => {
  const db = openLandingDb(':memory:');
  saveLedger(db, {
    products: [{ id: 'A-UK', code: 'A', marketplace: 'UK' }, { id: 'A-US', code: 'A', marketplace: 'US' }],
    orders: [
      { po: 'PO-1', supplier: 'S', marketplace: 'UK', invoices: [{ id: 'i1', kind: 'final', lines: [{ kind: 'goods', product: 'A-UK', qty: 100, rmb: 700 }] }] },
      { po: 'PO-2', supplier: 'S', marketplace: 'US', invoices: [{ id: 'i2', kind: 'final', lines: [{ kind: 'goods', product: 'A-US', qty: 100, rmb: 700 }] }] },
    ],
    payments: [
      { id: 'P-UK', date: '2026-03-04', usd: 100, allocations: [{ type: 'order', target: 'PO-1', part: 'full' }] },
      { id: 'P-US', date: '2026-03-04', usd: 100, allocations: [{ type: 'order', target: 'PO-2', part: 'full' }] },
      { id: 'P-GBP', date: '2026-03-04', gbp: 80, usd: 100, allocations: [{ type: 'order', target: 'PO-1', part: 'deposit' }] },
    ],
  }, { actor: 'test' });
  assert.deepEqual(paymentsNeedingRate(loadLedger(db)).map((p) => p.id), ['P-UK']);

  const { fetch } = qboFake({ rate: 0.8 });
  const qbo = qboFromConfig(db, { clientId: 'c', clientSecret: 's', realmId: '1', refreshToken: 'seed', fetch });
  const r = await fillRates({ db, qbo });
  assert.deepEqual(r.found, [{ payment: 'P-UK', rate: '0.8' }]);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'qbo_refresh_token'").get().value, 'rotated-1');
  assert.ok(!db.prepare('SELECT data FROM audit_log').all().some((a) => (a.data || '').includes('rotated'))); // token never in the audit log
  const line = computeLandingCosts(loadLedger(db)).orders.find((o) => o.po === 'PO-1').lines[0];
  assert.equal(fmt4(line.cost), '160.0000'); // 100 × 0.8 + 80
});
