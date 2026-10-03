import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpApi, spApiConfigured } from '../../src/amazon/spapi.js';

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    for (const [match, respond] of handlers) {
      if (match(u, init)) {
        const r = respond(u, init, calls);
        return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status || 200 });
      }
    }
    return new Response('{}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
const lwa = [(u) => u.hostname === 'api.amazon.com', () => ({ body: { access_token: 'tok', expires_in: 3600 } })];
const creds = { clientId: 'id', clientSecret: 'secret', refreshTokens: { EU: 'r-eu' } };

test('disabled until credentials exist, and only for regions with a token', () => {
  assert.equal(spApiConfigured({}), false);
  assert.equal(spApiConfigured({ clientId: 'a', clientSecret: 'b', refreshTokens: {} }), false);
  assert.equal(spApiConfigured(creds), true);
  assert.deepEqual(createSpApi(creds).marketplaces(), ['UK', 'DE']);
});

test('logs in once, sends the token, and follows NextToken to the end', async () => {
  const fetch = fakeFetch([
    lwa,
    [(u) => u.searchParams.get('QueryType') === 'DATE_RANGE', () => ({ body: { payload: { ShipmentData: [{ ShipmentId: 'FBA1' }], NextToken: 'n1' } } })],
    [(u) => u.searchParams.get('QueryType') === 'NEXT_TOKEN', () => ({ body: { payload: { ShipmentData: [{ ShipmentId: 'FBA2' }] } } })],
  ]);
  const api = createSpApi({ ...creds, fetch });
  const shipments = await api.getShipments('UK', { updatedAfter: '2026-09-01T00:00:00Z', updatedBefore: '2026-10-01T00:00:00Z' });
  assert.deepEqual(shipments.map((s) => s.ShipmentId), ['FBA1', 'FBA2']);
  assert.equal(fetch.calls.filter((c) => c.url.hostname === 'api.amazon.com').length, 1);
  const first = fetch.calls.find((c) => c.url.pathname === '/fba/inbound/v0/shipments');
  assert.equal(first.url.hostname, 'sellingpartnerapi-eu.amazon.com');
  assert.equal(first.url.searchParams.get('MarketplaceId'), 'A1F83G8C2ARO7P');
  assert.equal(first.init.headers['x-amz-access-token'], 'tok');
});

test('waits and retries when Amazon throttles', async () => {
  let n = 0;
  const slept = [];
  const fetch = fakeFetch([lwa, [(u) => u.pathname.endsWith('/items'), () => (++n < 3 ? { status: 429, body: {} } : { body: { payload: { ItemData: [{ SellerSKU: 'A' }] } } })]]);
  const api = createSpApi({ ...creds, fetch, sleep: async (ms) => slept.push(ms) });
  const items = await api.getShipmentItems('DE', 'FBA1');
  assert.equal(items.length, 1);
  assert.deepEqual(slept, [1000, 2000]);
});

test('a refused request fails with Amazon’s reason', async () => {
  const fetch = fakeFetch([lwa, [() => true, () => ({ status: 403, body: { errors: [{ message: 'Access to requested resource is denied.' }] } })]]);
  const api = createSpApi({ ...creds, fetch });
  await assert.rejects(api.getShipmentItems('UK', 'FBA1'), /403.*Access to requested resource is denied/);
});

test('finds a shipment’s 2024 IDs from its FBA ID, then renames it', async () => {
  const fetch = fakeFetch([
    lwa,
    [(u) => u.pathname.endsWith('/inboundPlans') && u.searchParams.get('status') === 'ACTIVE', () => ({ body: { inboundPlans: [{ inboundPlanId: 'wf1' }] } })],
    [(u) => u.pathname.endsWith('/inboundPlans'), () => ({ body: { inboundPlans: [] } })],
    [(u) => u.pathname.endsWith('/inboundPlans/wf1'), () => ({ body: { shipments: [{ shipmentId: 'sh1' }, { shipmentId: 'sh2' }] } })],
    [(u) => u.pathname.endsWith('/shipments/sh1'), () => ({ body: { shipmentConfirmationId: 'FBA-OTHER' } })],
    [(u) => u.pathname.endsWith('/shipments/sh2'), () => ({ body: { shipmentConfirmationId: 'FBA-MINE', name: 'Old name' } })],
    [(u, init) => init.method === 'PUT', () => ({ status: 204 })],
  ]);
  const api = createSpApi({ ...creds, fetch });
  const ref = await api.findInboundShipment('UK', 'FBA-MINE');
  assert.deepEqual(ref, { inboundPlanId: 'wf1', shipmentId: 'sh2', name: 'Old name' });
  await api.updateShipmentName('UK', ref, 'PO-020 Old name');
  const put = fetch.calls.find((c) => c.init.method === 'PUT');
  assert.equal(put.url.pathname, '/inbound/fba/2024-03-20/inboundPlans/wf1/shipments/sh2/name');
  assert.deepEqual(JSON.parse(put.init.body), { name: 'PO-020 Old name' });
});
