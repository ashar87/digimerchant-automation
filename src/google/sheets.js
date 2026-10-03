/**
 * Writes a table into one tab of a Google Sheet as a service account.
 *
 * Just the two calls needed (clear, then write), with the service-account
 * login done by hand (an RS256-signed JWT) rather than pulling in the whole
 * googleapis package. Off unless a key file and sheet ID are configured.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export function sheetsConfigured(cfg = {}) {
  return Boolean(cfg.keyFile && cfg.sheetId && fs.existsSync(cfg.keyFile));
}

export function createSheetsWriter({ keyFile, key: keyObject, sheetId, tab = 'COGS', fetch = globalThis.fetch, now = () => Date.now() }) {
  const key = keyObject || JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (!key.client_email || !key.private_key) throw new Error('The Google key file needs client_email and private_key');
  let token = null;

  async function accessToken() {
    if (token && token.expires > now() + 60_000) return token.value;
    const iat = Math.floor(now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`Google login failed: ${body.error_description || body.error || res.status}`);
    token = { value: body.access_token, expires: now() + (body.expires_in || 3600) * 1000 };
    return token.value;
  }

  async function call(method, path, body) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = text;
      try {
        detail = JSON.parse(text).error?.message || text;
      } catch {}
      throw new Error(`Google Sheets ${method} failed (${res.status}): ${detail}`);
    }
    return res.json().catch(() => null);
  }

  /** Replaces everything on the tab with `values` (an array of rows). */
  async function replaceTab(values) {
    const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
    await call('POST', `/values/${range}:clear`, {});
    await call('PUT', `/values/${range}!A1?valueInputOption=RAW`, { values });
    return { rows: values.length - 1 };
  }

  return { replaceTab, serviceAccount: key.client_email };
}
