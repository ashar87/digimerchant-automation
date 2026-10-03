/**
 * Server-rendered HTML with escaping by default. `html` escapes every
 * interpolated value unless it was itself built with `html` or `raw`, so a
 * supplier name or invoice description can never inject markup.
 */
import { D, fmt4, fmtMoney, fmtRmb } from '../landing/money.js';

class Safe {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

export const raw = (s) => new Safe(String(s));

export function esc(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(esc).join('');
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += esc(v) + strings[i + 1];
  });
  return new Safe(out);
}

/* ---------- formatting ---------- */

export const symbol = (currency) => (currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£');
export const unitCost = (v, currency) => (v === null || v === undefined ? '—' : `${symbol(currency)}${fmt4(v)}`);
export const money = (v, currency) => (v === null || v === undefined ? '—' : `${symbol(currency)}${fmtMoney(v)}`);
export const rmb = (v) => (v === null || v === undefined ? '—' : fmtRmb(v));
export const units = (v) => (v === null || v === undefined ? '—' : fmtRmb(D(v)));
export const pct = (v) => (v === null || v === undefined ? '—' : `${D(v).times(100).toFixed(2)}%`);

export const BATCH_STATUS = {
  final: ['Final', 'ok'],
  count_pending: ['Awaiting Amazon count', 'wait'],
  estimated: ['Estimated', 'est'],
  provisional: ['Deposit only', 'warn'],
  incomplete: ['Incomplete', 'bad'],
};
export const PAID_STATUS = { paid: ['Paid', 'ok'], deposit_paid: ['Deposit paid', 'wait'], unpaid: ['Unpaid', 'bad'] };
export const SHIPMENT_STATUSES = ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING', 'CLOSED', 'CANCELLED', 'DELETED', 'ERROR'];
export const shipmentStatusLabel = (s) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Unknown');

export const badge = ([label, tone]) => html`<span class="badge ${tone}">${label}</span>`;

export function select(name, options, selected, { blank = false, attrs = '' } = {}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return html`<select name="${name}" ${raw(attrs)}>${blank ? html`<option value=""></option>` : ''}${opts.map(
    (o) => html`<option value="${o.value}"${String(o.value) === String(selected ?? '') ? raw(' selected') : ''}>${o.label}</option>`
  )}</select>`;
}

/* ---------- layout ---------- */

const NAV = [
  ['/', 'Inbox'],
  ['/orders', 'Orders'],
  ['/shipments', 'Shipments'],
  ['/costs', 'Costs'],
  ['/payments', 'Payments'],
  ['/bills', 'Bills'],
  ['/sellerboard', 'Sellerboard'],
  ['/products', 'Products'],
  ['/annie', 'Annie'],
  ['/settings', 'Settings'],
];

export function layout({ title, path = '/', actor, inboxCount = 0, flash, body }) {
  const active = (href) => (href === '/' ? path === '/' : path.startsWith(href));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Landing costs</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <a class="brand" href="/">Landing costs</a>
  <nav>${NAV.map(
    ([href, label]) =>
      `<a href="${href}"${active(href) ? ' class="on"' : ''}>${esc(label)}${href === '/' && inboxCount ? ` <span class="count">${inboxCount}</span>` : ''}</a>`
  ).join('')}</nav>
  <a class="who" href="/who">${esc(actor || 'Who are you?')}</a>
</header>
<main>
${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
${esc(body)}
</main>
</body>
</html>`;
}

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#1f5f8b;
--btn-ink:#fff;--ok:#1e7a46;--ok-bg:#e6f4ea;--wait:#7a5a00;--wait-bg:#fdf3d6;--est:#5b3f99;--est-bg:#efe9fb;--warn:#a04a00;--warn-bg:#fdebd9;--bad:#a1232b;--bad-bg:#fbe4e5}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#7cb6e0;--btn-ink:#0f1d27;
--ok:#7fd3a0;--ok-bg:#1d3326;--wait:#e9c96b;--wait-bg:#3a3118;--est:#c2adf0;--est-bg:#2d2541;--warn:#f0a868;--warn-bg:#3d2a19;--bad:#f0959a;--bad-bg:#40201f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:10px 16px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1}
.brand{font-weight:650;color:var(--ink)}
nav{display:flex;flex-wrap:wrap;gap:2px 14px;flex:1}
nav a{color:var(--muted);padding:2px 0}nav a.on{color:var(--ink);font-weight:600;border-bottom:2px solid var(--accent)}
.count{background:var(--bad);color:#fff;border-radius:9px;padding:0 6px;font-size:12px;font-weight:600}
.who{font-size:13px;color:var(--muted)}
main{max-width:1180px;margin:0 auto;padding:18px 16px 60px}
h1{font-size:22px;margin:4px 0 4px}h2{font-size:16px;margin:26px 0 8px}h3{font-size:14px;margin:16px 0 6px}
.sub{color:var(--muted);margin:0 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.flash{background:var(--ok-bg);color:var(--ok);padding:8px 12px;border-radius:8px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
td:first-child{white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.total td{font-weight:600}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;white-space:nowrap}
.ok{background:var(--ok-bg);color:var(--ok)}.wait{background:var(--wait-bg);color:var(--wait)}.est{background:var(--est-bg);color:var(--est)}
.warn{background:var(--warn-bg);color:var(--warn)}.bad{background:var(--bad-bg);color:var(--bad)}
.muted{color:var(--muted)}.small{font-size:13px}
ul.items{list-style:none;padding:0;margin:0}
ul.items li{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)}
ul.items li:last-child{border-bottom:0}
.sev{font-weight:700;width:14px;flex:none}.sev.error{color:var(--bad)}.sev.warning{color:var(--warn)}.sev.info{color:var(--muted)}
form.inline{display:inline}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:2px}
input,select,textarea{font:inherit;padding:5px 7px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);max-width:100%}
input[type=number]{width:110px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px 14px;margin-bottom:12px}
.rows td{padding:3px 4px;border:0}.rows input,.rows select{width:100%}
button,.button{font:inherit;font-weight:600;padding:6px 14px;border-radius:7px;border:1px solid var(--accent);background:var(--accent);color:var(--btn-ink);cursor:pointer}
button.ghost{background:transparent;color:var(--accent)}button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
details{margin:6px 0}summary{cursor:pointer;color:var(--accent)}
dl.working{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:8px 0}
dl.working dt{color:var(--muted)}dl.working dd{margin:0;font-variant-numeric:tabular-nums}
.notice{background:var(--wait-bg);color:var(--wait);padding:8px 12px;border-radius:8px;margin:10px 0}
@media (max-width:640px){main{padding:12px 12px 40px}th,td{padding:5px 6px}}
`;
