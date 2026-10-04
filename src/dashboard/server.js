/**
 * The landing-cost dashboard: a private website for Ashar and Atif.
 *
 *   npm run dashboard        → http://127.0.0.1:3210
 *
 * Listens on 127.0.0.1 only. It's reached from other devices through
 * Tailscale later, never through a public address. Every edit is written
 * with the editor's name to the audit log.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { openLandingDb, loadLedger } from '../landing/store.js';
import { createSpApi, spApiConfigured } from '../amazon/spapi.js';
import { createSheetsWriter, sheetsConfigured } from '../google/sheets.js';
import { geminiInvoiceReader } from '../invoices/model.js';
import { createWise, wiseConfigured } from '../wise/client.js';
import { qboConfigured, qboFromConfig } from '../quickbooks/client.js';
import { computeLandingCosts } from '../landing/engine.js';
import { layout, raw } from './html.js';
import { inboxItems } from './views/inbox.js';
import { routes } from './routes.js';
import { HttpError } from './errors.js';
import { parseMultipart } from './multipart.js';

export const ACTORS = (process.env.DASHBOARD_USERS || 'Ashar,Atif').split(',').map((s) => s.trim()).filter(Boolean);

export { HttpError } from './errors.js';

export function createDashboard({ db, spapi = null, sheets = null, invoiceReader = null, wise = null, qbo = null }) {
  return http.createServer(async (req, res) => {
    try {
      await handle({ db, spapi, sheets, invoiceReader, wise, qbo }, req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error('[dashboard]', err);
      const heading = { 400: 'Check the form', 403: 'Refused', 404: 'Not found', 409: 'Someone else saved first' }[status] || 'Something went wrong';
      const back = err.back && err.back.startsWith('/') && !err.back.startsWith('//') ? err.back : '/';
      const who = parseCookies(req.headers.cookie).actor;
      send(res, status, layout({ title: heading, path: '', actor: ACTORS.includes(who) ? who : null, body: raw(`<h1>${heading}</h1><p>${escapeText(err.message)}</p><p><a href="${escapeText(back)}">${back === '/' ? 'Back to the inbox' : 'Open it again'}</a></p>`) }));
    }
  });
}

async function handle({ db, spapi, sheets, invoiceReader, wise, qbo }, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const cookies = parseCookies(req.headers.cookie);
  const actor = ACTORS.includes(cookies.actor) ? cookies.actor : null;

  if (req.method === 'POST' && !sameOrigin(req)) throw new HttpError(403, 'Refused: this form was not submitted from the dashboard.');

  // Choosing who you are is the one page that works before you've chosen.
  if (url.pathname === '/who') {
    if (req.method === 'POST') {
      const form = await readForm(req);
      const who = form.get('actor');
      if (!ACTORS.includes(who)) throw new HttpError(400, 'Unknown name');
      res.setHeader('Set-Cookie', `actor=${encodeURIComponent(who)}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`);
      return redirect(res, form.get('next') || '/');
    }
    return send(res, 200, layout({ title: 'Who are you?', path: '/who', actor, body: raw(whoPage(url.searchParams.get('next'))) }));
  }
  if (!actor) return redirect(res, `/who?next=${encodeURIComponent(url.pathname + url.search)}`);

  const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
  if (!route) throw new HttpError(404, `No page at ${url.pathname}`);
  const params = (url.pathname.match(route.pattern) || []).slice(1).map(decodeURIComponent);

  let cache;
  const ctx = {
    db,
    spapi,
    sheets,
    invoiceReader,
    wise,
    qbo,
    actor,
    url,
    params,
    ...(req.method === 'POST' ? await readBody(req) : { form: null, files: [] }),
    // Costs are recomputed from the source records on every page; nothing is cached between requests.
    get data() {
      if (!cache) {
        const ledger = loadLedger(db);
        cache = { ledger, result: computeLandingCosts(ledger) };
      }
      return cache;
    },
    fresh() {
      cache = null;
    },
  };

  const out = await route.handler(ctx);
  if (out?.redirect) return redirect(res, out.redirect);
  if (out?.text !== undefined) return send(res, 200, out.text, out.type || 'text/plain; charset=utf-8', out.headers);
  if (Buffer.isBuffer(out?.body)) return send(res, 200, out.body, out.type, out.headers);
  const inboxCount = inboxItems(ctx).filter((i) => i.count).length;
  send(res, 200, layout({ title: out.title, path: url.pathname, actor, inboxCount, flash: url.searchParams.get('ok'), body: out.body }));
}

function whoPage(next) {
  return `<h1>Who are you?</h1><p class="sub">Your name goes on every change you make.</p>
<form method="post" action="/who"><input type="hidden" name="next" value="${escapeText(next || '/')}">
${ACTORS.map((a) => `<button name="actor" value="${escapeText(a)}" style="margin-right:8px">${escapeText(a)}</button>`).join('')}</form>`;
}

/* ---------- http plumbing ---------- */

// A form posted from another site (CSRF) is refused. Browsers say where a
// request came from in Sec-Fetch-Site; older ones only send Origin.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return !origin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readBody(req) {
  const type = req.headers['content-type'] || '';
  const multipart = type.startsWith('multipart/form-data');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > (multipart ? 20_000_000 : 2_000_000)) throw new HttpError(413, multipart ? 'The file is over 15 MB' : 'Form too large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (multipart) {
    const { fields, files } = parseMultipart(body, type);
    return { form: fields, files };
  }
  return { form: new URLSearchParams(body.toString('utf8')), files: [] };
}

async function readForm(req) {
  return (await readBody(req)).form;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location) {
  // Only ever redirect within the dashboard.
  const safe = location.startsWith('/') && !location.startsWith('//') ? location : '/';
  res.writeHead(303, { Location: safe });
  res.end();
}

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ---------- entry point ---------- */

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.DASHBOARD_PORT || 3210);
  const db = openLandingDb(config.landingDbPath);
  const spapi = spApiConfigured(config.spapi) ? createSpApi(config.spapi) : null;
  const sheets = sheetsConfigured(config.sellerboard) ? createSheetsWriter(config.sellerboard) : null;
  // PDFs and photos are read by Gemini only when a key is set; Excel never needs it.
  const invoiceReader = config.geminiApiKey ? geminiInvoiceReader(await import('../providers/gemini.js')) : null;
  const wise = wiseConfigured(config.wise) ? createWise(config.wise) : null;
  const qbo = qboConfigured(config.qbo) ? qboFromConfig(db, config.qbo) : null;
  createDashboard({ db, spapi, sheets, invoiceReader, wise, qbo }).listen(port, '127.0.0.1', () => {
    console.log(`Landing-cost dashboard: http://127.0.0.1:${port}  (database ${config.landingDbPath})`);
  });
}
