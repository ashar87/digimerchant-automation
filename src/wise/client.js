/**
 * Reads transfers from Wise with a personal API token (read-only use). Wise
 * limits what personal tokens can do for UK/EEA accounts, so check the token
 * can list transfers before relying on this. Off unless WISE_API_TOKEN is set.
 */
const API = 'https://api.wise.com';

export function wiseConfigured(cfg = {}) {
  return Boolean(cfg.token);
}

export function createWise({ token, profileId = null, fetch = globalThis.fetch }) {
  async function get(path, query = {}) {
    const url = new URL(path, API);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Wise ${url.pathname} failed (${res.status})${res.status === 403 ? ': this token may not be allowed to read transfers' : ''}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /** The business profile, unless one is configured. */
  async function profile() {
    if (profileId) return profileId;
    const profiles = await get('/v1/profiles');
    const business = profiles.find((p) => p.type?.toLowerCase() === 'business') || profiles[0];
    if (!business) throw new Error('No Wise profile found for this token');
    profileId = business.id;
    return profileId;
  }

  /** Transfers created in [from, to), oldest first. */
  async function transfers({ from, to }) {
    const id = await profile();
    const out = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await get('/v1/transfers', { profile: id, createdDateStart: from, createdDateEnd: to, limit: 100, offset });
      out.push(...page);
      if (page.length < 100) break;
    }
    return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  }

  return { profile, transfers };
}
