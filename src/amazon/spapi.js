/**
 * A small Selling Partner API client: just the inbound-shipment calls the
 * landing-cost sync needs.
 *
 * Auth is Login with Amazon only (SP-API stopped requiring AWS signatures in
 * 2023): a refresh token per region is exchanged for a one-hour access token,
 * sent as x-amz-access-token. Nothing here runs unless credentials are set.
 */

export const MARKETPLACES = {
  UK: { id: 'A1F83G8C2ARO7P', region: 'EU' },
  DE: { id: 'A1PA6795UKMFR9', region: 'EU' },
  US: { id: 'ATVPDKIKX0DER', region: 'NA' },
};

const ENDPOINTS = {
  EU: 'https://sellingpartnerapi-eu.amazon.com',
  NA: 'https://sellingpartnerapi-na.amazon.com',
};
const LWA_URL = 'https://api.amazon.com/auth/o2/token';

export const ALL_STATUSES = ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'RECEIVING', 'CANCELLED', 'DELETED', 'CLOSED', 'ERROR', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN'];

export class SpApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** True when at least one region can be synced. */
export function spApiConfigured(cfg = {}) {
  return Boolean(cfg.clientId && cfg.clientSecret && Object.values(cfg.refreshTokens || {}).some(Boolean));
}

export function createSpApi({ clientId, clientSecret, refreshTokens = {}, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), maxRetries = 5 } = {}) {
  const tokens = new Map(); // region -> { value, expires }

  const regions = () => Object.keys(ENDPOINTS).filter((r) => refreshTokens[r]);
  const marketplaces = () => Object.keys(MARKETPLACES).filter((m) => refreshTokens[MARKETPLACES[m].region]);

  async function accessToken(region) {
    const cached = tokens.get(region);
    if (cached && cached.expires > now() + 60_000) return cached.value;
    if (!clientId || !clientSecret || !refreshTokens[region]) throw new SpApiError(0, `Amazon API isn't set up for ${region}`);
    const res = await fetch(LWA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshTokens[region], client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new SpApiError(res.status, `Amazon login failed for ${region}: ${body.error_description || body.error || res.status}`, body);
    tokens.set(region, { value: body.access_token, expires: now() + (body.expires_in || 3600) * 1000 });
    return body.access_token;
  }

  // Throttling (429) and Amazon-side errors are retried with backoff; anything else fails at once.
  async function request(region, method, path, { query, body } = {}) {
    const url = new URL(path, ENDPOINTS[region]);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, Array.isArray(v) ? v.join(',') : v);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { 'x-amz-access-token': await accessToken(region), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
      const text = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      let detail = text;
      try {
        detail = JSON.parse(text).errors?.map((e) => e.message).join('; ') || text;
      } catch {}
      throw new SpApiError(res.status, `Amazon ${method} ${url.pathname} failed (${res.status}): ${detail}`, text);
    }
  }

  /* ---------- Fulfillment Inbound v0: status and counts ---------- */

  /** Shipments by ID, or everything updated in a window. Follows NextToken to the end. */
  async function getShipments(marketplace, { ids, updatedAfter, updatedBefore, statuses = ALL_STATUSES } = {}) {
    const { id: marketplaceId, region } = MARKETPLACES[marketplace];
    const out = [];
    const batches = ids ? chunk(ids, 50) : [null];
    for (const batch of batches) {
      let query = batch
        ? { MarketplaceId: marketplaceId, QueryType: 'SHIPMENT', ShipmentIdList: batch }
        : { MarketplaceId: marketplaceId, QueryType: 'DATE_RANGE', ShipmentStatusList: statuses, LastUpdatedAfter: updatedAfter, LastUpdatedBefore: updatedBefore };
      for (;;) {
        const res = await request(region, 'GET', '/fba/inbound/v0/shipments', { query });
        out.push(...(res?.payload?.ShipmentData || []));
        const next = res?.payload?.NextToken;
        if (!next) break;
        query = { MarketplaceId: marketplaceId, QueryType: 'NEXT_TOKEN', NextToken: next };
      }
    }
    return out;
  }

  async function getShipmentItems(marketplace, shipmentId) {
    const { id: marketplaceId, region } = MARKETPLACES[marketplace];
    const res = await request(region, 'GET', `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/items`, { query: { MarketplaceId: marketplaceId } });
    return res?.payload?.ItemData || [];
  }

  /* ---------- Fulfillment Inbound 2024-03-20: renaming ---------- */

  const V2024 = '/inbound/fba/2024-03-20';

  async function listInboundPlans(region, { status, pageSize = 30 } = {}) {
    const out = [];
    let paginationToken;
    do {
      const res = await request(region, 'GET', `${V2024}/inboundPlans`, { query: { pageSize, status, paginationToken, sortBy: 'LAST_UPDATED_TIME', sortOrder: 'DESC' } });
      out.push(...(res?.inboundPlans || []));
      paginationToken = res?.pagination?.nextToken;
    } while (paginationToken && out.length < 300);
    return out;
  }

  /**
   * The 2024 API names shipments by plan and its own shipment ID; the FBA ID
   * printed everywhere is its shipmentConfirmationId. This finds one from the other.
   */
  async function findInboundShipment(marketplace, fbaId) {
    const { region } = MARKETPLACES[marketplace];
    for (const status of ['ACTIVE', 'SHIPPED']) {
      for (const plan of await listInboundPlans(region, { status })) {
        const detail = await request(region, 'GET', `${V2024}/inboundPlans/${encodeURIComponent(plan.inboundPlanId)}`);
        for (const s of detail?.shipments || []) {
          const shipment = await request(region, 'GET', `${V2024}/inboundPlans/${encodeURIComponent(plan.inboundPlanId)}/shipments/${encodeURIComponent(s.shipmentId)}`);
          if (shipment?.shipmentConfirmationId === fbaId) return { inboundPlanId: plan.inboundPlanId, shipmentId: s.shipmentId, name: shipment.name };
        }
      }
    }
    return null;
  }

  async function updateShipmentName(marketplace, { inboundPlanId, shipmentId }, name) {
    const { region } = MARKETPLACES[marketplace];
    await request(region, 'PUT', `${V2024}/inboundPlans/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/name`, { body: { name } });
  }

  return { regions, marketplaces, getShipments, getShipmentItems, findInboundShipment, updateShipmentName };
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}
