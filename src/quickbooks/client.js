/**
 * QuickBooks Online exchange rates: the same "QB rate" that's copied by hand
 * today, for any currency and date. A rate is used only when QuickBooks has
 * one for that exact day; otherwise the payment shows "rate pending" rather
 * than quietly borrowing another day's rate.
 *
 * Intuit rotates the refresh token on every use, so the newest one is kept in
 * the database (settings: qbo_refresh_token), seeded from QBO_REFRESH_TOKEN.
 */
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API = { production: 'https://quickbooks.api.intuit.com', sandbox: 'https://sandbox-quickbooks.api.intuit.com' };

export function qboConfigured(cfg = {}) {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.realmId && cfg.refreshToken);
}

export function createQbo({ clientId, clientSecret, realmId, environment = 'production', loadRefreshToken, saveRefreshToken, fetch = globalThis.fetch, now = () => Date.now() }) {
  let access = null;

  async function token() {
    if (access && access.expires > now() + 60_000) return access.value;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: loadRefreshToken() }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`QuickBooks login failed: ${body.error_description || body.error || res.status}. If it says invalid_grant, connect QuickBooks again.`);
    if (body.refresh_token) saveRefreshToken(body.refresh_token);
    access = { value: body.access_token, expires: now() + (body.expires_in || 3600) * 1000 };
    return access.value;
  }

  /** GBP per `currency` on `date`, or { rate: null } when QuickBooks has no rate for that exact day. */
  async function exchangeRate(currency, date) {
    const url = new URL(`/v3/company/${encodeURIComponent(realmId)}/exchangerate`, API[environment] || API.production);
    url.searchParams.set('sourcecurrencycode', currency);
    url.searchParams.set('asofdate', date);
    url.searchParams.set('minorversion', '75');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`QuickBooks exchange rate failed (${res.status}): ${body.Fault?.Error?.[0]?.Detail || body.Fault?.Error?.[0]?.Message || ''}`);
    const r = body.ExchangeRate;
    if (!r || r.Rate === undefined || r.AsOfDate !== date) return { rate: null, asOf: r?.AsOfDate || null, target: r?.TargetCurrencyCode || null };
    return { rate: String(r.Rate), asOf: r.AsOfDate, target: r.TargetCurrencyCode };
  }

  return { exchangeRate };
}

/**
 * A client whose rotating refresh token lives in the landing database. Written
 * straight to settings, deliberately not through setSetting, so the token never
 * lands in the audit log.
 */
export function qboFromConfig(db, cfg) {
  const read = () => db.prepare("SELECT value FROM settings WHERE key = 'qbo_refresh_token'").get()?.value || cfg.refreshToken;
  const write = (token) => db.prepare("INSERT INTO settings (key, value) VALUES ('qbo_refresh_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(token);
  return createQbo({ ...cfg, loadRefreshToken: read, saveRefreshToken: write });
}
