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

// Line icons (24px viewBox, 2px stroke), drawn inline so nothing loads from elsewhere.
const ICON = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>',
  purchasing: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  shipping: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38a1 1 0 0 0-.78-.38H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  costs: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`;

// Grouped by how the work flows: buy, then ship, then cost. Settings sits apart.
export const NAV = [
  { key: 'inbox', label: 'Inbox', href: '/', tabs: [['/', 'Inbox']] },
  { key: 'tasks', label: 'Tasks', href: '/tasks', tabs: [['/tasks', 'Tasks']] },
  { key: 'purchasing', label: 'Purchasing', href: '/orders', tabs: [['/orders', 'Orders'], ['/invoices', 'Invoices'], ['/payments', 'Payments'], ['/annie', 'Annie']], also: ['/wise'] },
  { key: 'shipping', label: 'Shipping', href: '/shipments', tabs: [['/shipments', 'Shipments'], ['/bills', 'Courier bills']] },
  { key: 'costs', label: 'Costs', href: '/costs', tabs: [['/costs', 'Landing costs'], ['/sellerboard', 'Sellerboard']] },
];
const SETTINGS = { key: 'settings', label: 'Settings', href: '/settings', tabs: [['/products', 'Products'], ['/messages', 'Messages'], ['/settings', 'Settings']] };

const under = (path, href) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`) || path.startsWith(`${href}.`));
function groupFor(path) {
  return [...NAV, SETTINGS].find((g) => g.tabs.some(([href]) => under(path, href)) || (g.also || []).some((href) => under(path, href))) || null;
}

export function layout({ title, path = '/', actor, inboxCount = 0, flash, body }) {
  const group = groupFor(path);
  const badge = (g) => (g.key === 'inbox' && inboxCount ? ` <span class="count" aria-label="${inboxCount} need you">${inboxCount}</span>` : '');
  const mainLink = (g, cls) =>
    `<a class="${cls}${group?.key === g.key ? ' on' : ''}" href="${g.href}"${group?.key === g.key ? ' aria-current="page"' : ''}>${icon(g.key)}<span>${esc(g.label)}</span>${badge(g)}</a>`;
  const subTabs =
    group && group.tabs.length > 1
      ? `<nav class="subtabs" aria-label="${esc(group.label)}">${group.tabs
          .map(([href, label]) => `<a href="${href}"${under(path, href) || (href === '/payments' && under(path, '/wise')) ? ' class="on" aria-current="page"' : ''}>${esc(label)}</a>`)
          .join('')}</nav>`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · Landing costs</title>
<style>${CSS}</style>
<script src="/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="/">Digi Merchant</a>
  <nav class="main" aria-label="Main">${NAV.map((g) => mainLink(g, 'tab')).join('')}</nav>
  <div class="right">
    <a class="cog${group?.key === 'settings' ? ' on' : ''}" href="/settings" aria-label="Settings" title="Settings">${icon('settings')}</a>
    <a class="who" href="/who">${esc(actor || 'Who are you?')}</a>
  </div>
</header>
${subTabs}
<main id="main">
${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}
${esc(body)}
</main>
<nav class="bottom" aria-label="Main">${NAV.map((g) => mainLink(g, 'bt')).join('')}</nav>
</body>
</html>`;
}

/**
 * Served as /app.js. Copies each table's column headings onto its cells, so on a
 * phone every row can be shown as a labelled card instead of a table that runs
 * off the right of the screen.
 */
export const APP_JS = `document.querySelectorAll('table').forEach(function (t) {
  var ths = t.querySelectorAll('thead th');
  var heads = Array.prototype.map.call(ths, function (th) { return th.textContent.trim(); });
  if (!heads.length) return;
  t.classList.add('stack');
  t.querySelectorAll('tbody tr').forEach(function (tr) {
    Array.prototype.forEach.call(tr.children, function (td, i) {
      if (!td.hasAttribute('data-label') && heads[i]) td.setAttribute('data-label', heads[i]);
      // The column marked "key" is the figure that matters; on a phone it sits on the card's top line.
      if (ths[i] && ths[i].classList.contains('key')) td.classList.add('key');
    });
  });
});`;

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--accent:#1f5f8b;
--btn-ink:#fff;--ok:#1e7a46;--ok-bg:#e6f4ea;--wait:#7a5a00;--wait-bg:#fdf3d6;--est:#5b3f99;--est-bg:#efe9fb;--warn:#a04a00;--warn-bg:#fdebd9;--bad:#a1232b;--bad-bg:#fbe4e5}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#7cb6e0;--btn-ink:#0f1d27;
--ok:#7fd3a0;--ok-bg:#1d3326;--wait:#e9c96b;--wait-bg:#3a3118;--est:#c2adf0;--est-bg:#2d2541;--warn:#f0a868;--warn-bg:#3d2a19;--bad:#f0959a;--bad-bg:#40201f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header.top{display:flex;align-items:center;gap:8px 22px;padding:8px 16px;background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
.brand{font-weight:650;color:var(--ink);white-space:nowrap}
.ic{width:18px;height:18px;flex:none}
nav.main{display:flex;gap:4px;flex:1;flex-wrap:wrap}
nav.main a{display:flex;align-items:center;gap:6px;color:var(--muted);padding:8px 10px;border-radius:8px;min-height:40px}
nav.main a:hover{background:var(--bg);text-decoration:none}
nav.main a.on{color:var(--ink);font-weight:600;background:var(--bg)}
.right{display:flex;align-items:center;gap:6px;margin-left:auto}
.cog{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;color:var(--muted)}
.cog.on,.cog:hover{color:var(--ink);background:var(--bg)}
.count{background:var(--bad);color:#fff;border-radius:9px;padding:0 6px;font-size:12px;font-weight:600;line-height:18px}
.who{font-size:13px;color:var(--muted);padding:8px 4px}
nav.subtabs{display:flex;gap:6px;padding:8px 16px;background:var(--card);border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
nav.subtabs a{white-space:nowrap;color:var(--muted);padding:6px 12px;border-radius:999px;border:1px solid var(--line);min-height:34px;display:flex;align-items:center}
nav.subtabs a.on{color:var(--ink);font-weight:600;border-color:var(--accent)}
nav.bottom{display:none}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;z-index:100;background:var(--card);padding:8px}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
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
.rules{margin:10px 0 0;padding-left:22px}.rules li{margin:0 0 8px}
.pager{display:flex;gap:18px;align-items:center}
.board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
.board .col h2{margin:8px 0}
ul.tasks{list-style:none;margin:0;padding:0}
.task{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0 0 8px}
.task .t-title{font-weight:600}.task .t-meta{margin-top:4px}.task .t-move{display:flex;gap:8px;margin-top:8px}
nav.seg{display:none}
.filters{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end}
label.check{display:flex;align-items:center;gap:6px}
a.danger-link{color:var(--bad)}
blockquote{margin:6px 0 0;padding-left:10px;border-left:3px solid var(--line)}
.notice{background:var(--wait-bg);color:var(--wait);padding:8px 12px;border-radius:8px;margin:10px 0}
@media (max-width:760px){
  body{font-size:16px}
  header.top{position:static;padding:8px 12px}
  nav.main{display:none}
  nav.bottom{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:10;background:var(--card);border-top:1px solid var(--line);padding:4px 4px calc(4px + env(safe-area-inset-bottom))}
  nav.bottom a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:52px;color:var(--muted);font-size:11px;position:relative;text-decoration:none}
  nav.bottom a.on{color:var(--accent);font-weight:600}
  nav.bottom .ic{width:22px;height:22px}
  nav.bottom .count{position:absolute;top:2px;left:calc(50% + 6px);font-size:10px;line-height:16px;padding:0 5px}
  main{padding:12px 12px calc(84px + env(safe-area-inset-bottom))}
  h1{font-size:20px}
  input,select,textarea,button,.button{font-size:16px;min-height:44px}
  input[type=checkbox]{min-height:auto}
  .grid{grid-template-columns:1fr}
  /* Tables become labelled cards: one card per row, the heading beside each value. */
  table.stack thead{display:none}
  table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:100%}
  table.stack tr{border:1px solid var(--line);border-radius:8px;padding:6px 10px;margin:0 0 8px;background:var(--card)}
  table.stack td{display:flex;justify-content:space-between;gap:12px;border:0;padding:4px 0;text-align:right;white-space:normal;overflow-wrap:anywhere}
  table.stack td::before{content:attr(data-label);color:var(--muted);font-size:13px;text-align:left;flex:none;max-width:45%}
  table.stack td:not([data-label])::before,table.stack td[data-label=""]::before{content:none}
  table.stack td:first-child{font-weight:600;white-space:normal}
  table.stack td:empty{display:none}
  table.stack tr.total{background:var(--bg)}
  /* Card top line: what the row is (first column) on the left, its key figure on the right. */
  table.stack:not(.rows) tr{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:12px}
  table.stack:not(.rows) td{flex:0 0 100%}
  table.stack:not(.rows) td:first-child{flex:1 1 0;order:-2;justify-content:flex-start;text-align:left;font-size:17px}
  table.stack:not(.rows) td:first-child::before{content:none}
  table.stack:not(.rows) td.key{flex:0 0 auto;width:auto;max-width:55%;text-align:right;order:-1;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
  table.stack:not(.rows) td.key::before{content:none}
  .card.scroll{padding:0;border:0;background:transparent}
  /* Task board: one column at a time, picked with the segmented control. */
  .board{grid-template-columns:1fr}
  .board .col:not(.sel){display:none}
  .board .col h2{display:none}
  nav.seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:10px 0}
  nav.seg a{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px;color:var(--ink);text-decoration:none;background:var(--card)}
  nav.seg a+a{border-left:1px solid var(--line)}
  nav.seg a.on{background:var(--accent);color:var(--btn-ink);font-weight:600}
  nav.seg a.on .muted{color:inherit}
  .task .t-move button{flex:1}
  .filters>div{flex:1 1 140px}
  .grid input,.grid select{width:100%}
  /* Form grids (invoice lines, payment rows): each row becomes a stack of labelled fields. */
  table.rows.stack td{display:block;text-align:left}
  table.rows.stack td::before{display:block;margin-bottom:2px}
  table.rows.stack td input,table.rows.stack td select{width:100%}
}
`;
