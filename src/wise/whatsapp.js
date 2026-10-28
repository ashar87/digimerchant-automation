/**
 * The Wise payment messages Ashar posts in the supplier group: the USD sent and
 * a wise.com link. Each becomes a Wise transfer waiting to be recorded (the
 * /wise page and the Inbox), so the payment form opens already filled in.
 *
 * The message doesn't say what the USD cost in GBP. The link's page is read for
 * it, best effort: a tracking page made for the recipient may not show it, in
 * which case the GBP is typed in on the payment form.
 */
const LINK = /https:\/\/(?:[\w-]+\.)*wise\.com\/[^\s<>"')]+/i;
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const USD = [new RegExp(`(?:US\\$|\\$|USD\\s*)${NUM}`, 'i'), new RegExp(`${NUM}\\s*(?:USD|US dollars?|dollars?)\\b`, 'i')];
const GBP = [new RegExp(`(?:£|GBP\\s*)${NUM}`, 'i'), new RegExp(`${NUM}\\s*GBP\\b`, 'i')];
const amount = (res, s) => {
  for (const re of res) {
    const m = re.exec(s);
    if (m) return m[1].replace(/,/g, '');
  }
  return null;
};

/** The link and USD amount in a message, or null if it isn't a Wise payment message. */
export function parseWiseMessage(body = '') {
  const link = LINK.exec(body)?.[0] || null;
  if (!link) return null;
  const text = body.replace(link, ' ');
  return { link, usd: amount(USD, text), gbp: amount(GBP, text) };
}

const isWise = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'wise.com' || u.hostname.endsWith('.wise.com'));
  } catch {
    return false;
  }
};

/**
 * What the link's page says: the GBP paid and the USD sent, where it shows
 * them. Only wise.com pages are opened, with no cookies. Never throws.
 */
export async function readWiseLink(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!isWise(url)) return { error: 'not a wise.com link' };
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (Digi Merchant dashboard)', Accept: 'text/html' } });
    if (res.url && !isWise(res.url)) return { error: 'the link led away from wise.com' };
    if (!res.ok) return { error: `wise.com answered ${res.status}` };
    const page = (await res.text()).slice(0, 2_000_000);
    // Visible text and the JSON a page carries for its scripts both count.
    const text = page.replace(/<script[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&pound;|&#163;/g, '£').replace(/\s+/g, ' ');
    const json = /"sourceCurrency"\s*:\s*"GBP"[\s\S]{0,400}?"sourceAmount"\s*:\s*"?([\d.]+)/.exec(page) || /"sourceAmount"\s*:\s*"?([\d.]+)"?[\s\S]{0,400}?"sourceCurrency"\s*:\s*"GBP"/.exec(page);
    return { gbp: json?.[1] || amount(GBP, text), usd: amount(USD, text) };
  } catch (err) {
    return { error: err.name === 'TimeoutError' ? 'wise.com didn’t answer in time' : err.message };
  }
}

/**
 * Records a Wise message as a transfer waiting to be recorded. Returns the row
 * and what the link gave, or null if the message isn't one (or was seen before).
 */
export async function noteWiseMessage(db, { id, timestamp, body, readLink = readWiseLink }) {
  const parsed = parseWiseMessage(body);
  if (!parsed) return null;
  const key = `wa:${id}`;
  if (db.prepare('SELECT 1 FROM wise_transfers WHERE id = ?').get(key)) return null;
  const page = await readLink(parsed.link);
  const usd = parsed.usd || page.usd || null;
  const gbp = parsed.gbp || page.gbp || null;
  const created = new Date(timestamp * 1000).toISOString();
  const reference = body.replace(parsed.link, '').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
  db.prepare(`INSERT INTO wise_transfers (id, created, reference, status, source_currency, source_value, target_currency, target_value, rate, raw)
    VALUES (?, ?, ?, 'outgoing_payment_sent', ?, ?, ?, ?, NULL, ?)`)
    .run(key, created, reference, gbp ? 'GBP' : null, gbp, usd ? 'USD' : null, usd, JSON.stringify({ from: 'whatsapp', link: parsed.link, page: page.error ? { error: page.error } : { gbp: page.gbp || null, usd: page.usd || null } }));
  return { id: key, usd, gbp, gbpFrom: parsed.gbp ? 'message' : page.gbp ? 'link' : null, linkError: page.error || null };
}
