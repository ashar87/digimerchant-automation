import fs from 'node:fs';
import path from 'node:path';
import { html, select, rmb, money, unitCost } from '../html.js';
import { documentsSection } from './files.js';
import { ROOT } from '../../config.js';
import { fmtMoney } from '../../landing/money.js';
import { addAttachment } from '../../files/attachments.js';
import { intakeBill, getBillDraft, pendingBillDrafts, closeBillDraft } from '../../bills/intake.js';
import { INVOICE_DIR } from '../../invoices/intake.js';
import { saveLedger, deleteRecord } from '../../landing/store.js';
import { computeLandingCosts } from '../../landing/engine.js';
import { queueBillCards } from '../../notify/bills.js';
import { text, number, date, required, rows, compact, uniqueId } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { enc } from './common.js';
import { history } from './orders.js';
import { versionField, assertFresh } from '../versions.js';

const KINDS = [
  { value: 'shipping', label: 'Shipping' },
  { value: 'domestic', label: 'Domestic shipping' },
  { value: 'fee', label: 'Fee (shared)' },
  { value: 'adjustment', label: 'Adjustment (rate diff, credit)' },
  { value: 'expense', label: 'Expense (not landing cost)' },
  { value: 'onward', label: 'To a 3PL / home (FBA shipment later)' },
];
/** Goods that go to a 3PL or your own warehouse before Amazon, shown on the Courier bills page. Each step is what the system does or needs. */
export const ONWARD_STEPS = [
  ['How to spot it', 'A row on Annie’s bill with shipping charged but no FBA ID: the goods are going to a 3PL or your home, and reach Amazon later in a shipment you create then. Its domestic shipping fee row has no FBA ID either.'],
  ['Read the bill as usual', 'Upload it here. Those rows come in as “To a 3PL / home (FBA shipment later)” lines, flagged on the check page. If a row does have an FBA ID that just couldn’t be read, type the ID in and change the kind to Shipping instead.'],
  ['Say where the goods went', 'Put the place in the line’s description, e.g. “UK 3PL” or “Home, Leeds”, so you can find it later. Typing a bill in by hand: choose the same kind, leave FBA shipment blank, and fill in the description.'],
  ['Save it and pay it as normal', 'Record the payment against the whole bill, as for any courier bill. The held line’s share of the payment waits on the bill; it isn’t lost and isn’t added to the other shipments.'],
  ['Until then it’s held', 'The held amount isn’t in any landing cost yet, and the Inbox keeps a reminder for each bill that has one. The goods are still part of their PO, so the PO’s goods cost is unchanged.'],
  ['When the goods go to Amazon', 'Create the shipment in Send to Amazon from the 3PL or your address, with the PO in its name as usual (“PO-041 UK”). Then add it on Shipping → Shipments → Add shipment with just its FBA ID and marketplace: the Amazon check (each morning, or “Check Amazon now”) fills in its units, links the PO from its name, and keeps its status and receive date up to date.'],
  ['Put the FBA ID on the held line', 'Open this courier bill, type the new FBA shipment ID on the held line (keep the kind) and save. Do the same for its domestic fee line. The cost then counts towards that shipment and the Inbox reminder clears.'],
  ['Sent in more than one shipment?', 'Split the held line into one line per FBA shipment, sharing the RMB by units. E.g. 600 RMB for 1,000 units sent as 400 + 600: lines of 240 RMB and 360 RMB. Keep the bill’s total the same.'],
  ['Until the line names it', 'If the FBA shipment is in the dashboard but the held line doesn’t name it yet, its delivery cost is estimated from the last shipment of the same product. Its landing cost and Sellerboard cost are only right once the line names it.'],
  ['The second leg is an expense', 'Getting the goods from the 3PL or your home to Amazon (UK courier, 3PL storage and handling) is a one-off expense, not landing cost. Don’t add it here; book it in the accounts as an expense.'],
];

const onwardGuide = (open = false) => html`<details class="card" id="no-fba-id"${open ? ' open' : ''}><summary><b>Goods sent to a 3PL or your own warehouse (no FBA ID yet)</b></summary>
<ol class="rules">${ONWARD_STEPS.map(([title, text]) => html`<li><b>${title}.</b> ${text}</li>`)}</ol></details>`;

const METHOD = { excel: 'Read exactly from the Excel file.', model: 'Read by Gemini. Anything it couldn’t read is left blank, never guessed.', none: 'Not read automatically.', failed: 'Reading failed.' };
const BLANK_LINES = 6;

export function billsPage(ctx) {
  const { ledger } = ctx.data;
  const body = html`
<h1>Courier bills</h1>
<p class="sub">Each line names its FBA shipment, so a bill covering many orders attaches line by line.</p>
${onwardGuide()}
<form class="card" method="post" action="/bills/upload" enctype="multipart/form-data">
<div class="grid"><div><label for="bill-file">Courier bill (photo, PDF or Excel)</label><input id="bill-file" type="file" name="file" required accept=".xlsx,.pdf,.jpg,.jpeg,.png,.webp,.heic"></div></div>
<button>Read bill</button> <span class="muted small">You check it before it’s saved.${ctx.billReader ? '' : ' Gemini reading isn’t set up here, so photos and PDFs will need their lines typed in.'} Or <a href="/bills/new">type one in</a>.</span>
</form>
${(() => {
  const drafts = pendingBillDrafts(ctx.db);
  return drafts.length
    ? html`<h2>Waiting to be checked (${drafts.length})</h2><div class="card"><ul class="items">${drafts.map((d) => html`<li><div><a href="/bills/drafts/${d.id}">${d.filename || `Bill ${d.id}`}</a>
  <div class="muted small">Uploaded by ${d.created_by} · ${d.created_at.slice(0, 16).replace('T', ' ')} · ${d.reading.lines?.length || 0} line(s)</div></div></li>`)}</ul></div>`
    : '';
})()}
<h2>Bills</h2>
<div class="card scroll"><table><thead><tr><th>Date</th><th>Bill</th><th>Agent</th><th>Shipments</th><th class="n">RMB</th></tr></thead><tbody>
${[...ledger.courierBills].reverse().map((b) => html`<tr><td>${b.date || ''}</td><td><a href="/bills/${enc(b.id)}">${b.id}</a></td><td>${b.agent || ''}</td>
<td class="small">${[...new Set(b.lines.map((l) => l.shipment).filter(Boolean))].join(', ')}</td><td class="n">${rmb(b.lines.reduce((a, l) => a + Number(l.rmb || 0), 0))}</td></tr>`)}
</tbody></table></div>`;
  return { title: 'Courier bills', body };
}

export function billPage(ctx) {
  const { ledger, result } = ctx.data;
  const id = ctx.params[0];
  const bill = id ? ledger.courierBills.find((b) => b.id === id) : null;
  if (id && !bill) throw notFound(`Courier bill ${id}`);
  const allocations = bill ? result.shipments.flatMap((s) => s.delivery.bills.filter((b) => b.bill === bill.id).map((b) => ({ shipment: s, ...b }))) : [];
  const paidBy = bill ? ledger.payments.filter((p) => p.allocations.some((a) => a.type === 'bill' && a.target === bill.id)) : [];
  const issues = bill ? result.issues.filter((i) => i.ref === bill.id && i.severity !== 'info') : [];

  const body = html`
<p class="muted small"><a href="/bills">Courier bills</a></p>
<h1>${bill ? bill.id : 'Add a courier bill'}</h1>
${bill
  ? html`<p>${bill.agent || ''} ${bill.date || ''} · paid by ${paidBy.length ? paidBy.map((p, i) => html`${i ? ', ' : ''}<a href="/payments/${enc(p.id)}">${p.id}</a>`) : html`no payment yet — <a href="/payments/new">record it</a> with a “Courier bill” row for ${bill.id}`}</p>
${issues.map((i) => html`<p class="notice">${i.message}</p>`)}
${bill.lines.some((l) => l.kind === 'onward' && !l.shipment) ? html`<p class="small">Goods on this bill went to a 3PL or your home. <a href="/bills#no-fba-id">How to finish the held line</a> once they go to Amazon.</p>` : ''}
${allocations.length
  ? html`<h2>Allocated to shipments</h2><div class="card scroll"><table><thead><tr><th>Shipment</th><th class="n">Share</th><th class="n">Delivery cost</th><th class="n">Per unit</th></tr></thead><tbody>
${allocations.map((a) => html`<tr><td><a href="/shipments/${enc(a.shipment.id)}">${a.shipment.id}</a> ${a.shipment.marketplace}</td><td class="n">${a.share ? `${a.share.times(100).toFixed(2)}%` : '—'}</td><td class="n">${money(a.amount, a.shipment.currency)}</td><td class="n">${unitCost(a.shipment.delivery.perUnit, a.shipment.currency)}</td></tr>`)}
</tbody></table></div>`
  : ''}`
  : ''}
<h2>${bill ? 'Edit' : 'Lines'}</h2>
${billForm(ctx, bill, { action: `/bills${bill ? `/${enc(bill.id)}` : ''}`, submit: bill ? 'Save bill' : 'Add bill', version: bill ? versionField(bill) : '' })}
${bill ? documentsSection(ctx, 'courier_bill', bill.id, { title: 'The bill', back: `/bills/${enc(bill.id)}`, hint: 'e.g. Annie’s bill' }) : ''}
${bill ? html`<form method="post" action="/bills/${enc(bill.id)}/delete" data-confirm="Delete courier bill ${bill.id}? Its shipments go back to estimated delivery costs.">${versionField(bill)}<button class="danger">Delete bill</button></form>${history(ctx, 'courier_bill', bill.id)}` : ''}`;
  return { title: bill ? bill.id : 'New courier bill', body };
}

export function saveBill(ctx) {
  const { ledger } = ctx.data;
  const existingId = ctx.params[0];
  const existing = existingId ? ledger.courierBills.find((b) => b.id === existingId) : null;
  if (existingId && !existing) throw notFound(`Courier bill ${existingId}`);
  if (existing) assertFresh(ctx, 'courier_bill', existingId, existing, `/bills/${enc(existingId)}`);
  const bill = billFromForm(ctx, existingId);
  storeBill(ctx, bill);
  return { redirect: `/bills/${enc(bill.id)}?ok=${enc(`${bill.id} saved.`)}` };
}

function storeBill(ctx, bill) {
  const before = computeLandingCosts(ctx.data.ledger);
  saveLedger(ctx.db, { courierBills: [bill] }, { actor: ctx.actor });
  queueBillCards(ctx.db, [bill.id], before);
}

function billFromForm(ctx, existingId) {
  const { ledger } = ctx.data;
  const f = ctx.form;
  const d = date(f.get('date'), 'Date', { required: true });
  const agent = text(f, 'agent');

  const lines = rows(f, 'line', ['kind', 'shipment', 'rmb', 'description'], ['shipment', 'rmb', 'description']).map((l, i) => {
    const where = `Line ${i + 1}`;
    if (!KINDS.some((k) => k.value === l.kind)) throw new HttpError(400, `${where}: unknown kind`);
    const shipment = l.shipment ? l.shipment.toUpperCase() : undefined;
    if ((l.kind === 'shipping' || l.kind === 'domestic') && !shipment) throw new HttpError(400, `${where}: ${l.kind === 'domestic' ? 'domestic shipping' : 'shipping'} needs its FBA shipment`);
    if (!l.rmb) throw new HttpError(400, `${where}: enter its RMB amount`);
    if ((l.kind === 'adjustment' || l.kind === 'expense') && !l.description) throw new HttpError(400, `${where}: say what the ${l.kind} is`);
    if (l.kind === 'onward' && !l.description && !shipment) throw new HttpError(400, `${where}: say where the goods went (a 3PL or home), or give the FBA shipment they went to Amazon in`);
    const line = compact({ kind: l.kind, shipment, rmb: number(l.rmb, `${where} RMB`) });
    if (l.description) line[l.kind === 'expense' ? 'category' : 'description'] = l.description;
    return line;
  });
  if (!lines.length) throw new HttpError(400, 'A bill needs at least one line');
  if (lines.length > 1 && lines.some((l) => l.rmb === undefined)) throw new HttpError(400, 'Every line needs its RMB amount (only a one-line bill may give USD alone)');

  const id = existingId || uniqueId(`${(agent || 'BILL').toUpperCase().replace(/[^A-Z0-9]+/g, '-')}-${d}`, new Set(ledger.courierBills.map((b) => b.id)));
  const bill = compact({ id, agent, date: d, statedTotalRmb: required(number(f.get('statedTotalRmb'), 'Bill total'), 'Total on the bill'), rmbPerUsd: required(number(f.get('rmbPerUsd'), 'Rate'), 'Rate on the bill') });
  bill.lines = lines;
  return bill;
}

/* ---------------------------- reading a bill ---------------------------- */

export async function uploadBill(ctx) {
  const file = ctx.files.find((f) => f.name === 'file');
  if (!file) throw new HttpError(400, 'Choose a file to upload');
  try {
    const draft = await intakeBill({ db: ctx.db, buffer: file.data, filename: file.filename, mime: file.mime, actor: ctx.actor, reader: ctx.billReader });
    return { redirect: `/bills/drafts/${draft.id}` };
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

function loadBillDraft(ctx) {
  const draft = getBillDraft(ctx.db, Number(ctx.params[0]));
  if (!draft) throw notFound(`Bill ${ctx.params[0]}`);
  return draft;
}

export function billDraftPage(ctx) {
  const draft = loadBillDraft(ctx);
  const r = draft.reading;
  const bill = { agent: r.agent || 'Annie', date: r.date, statedTotalRmb: r.statedTotalRmb, rmbPerUsd: r.rmbPerUsd, lines: r.lines || [] };
  const body = html`
<p class="muted small"><a href="/bills">Courier bills</a></p>
<h1>Check before saving</h1>
<p class="sub">${draft.filename || 'Courier bill'} · ${METHOD[r.method] || ''} <a href="/bills/drafts/${draft.id}/file" target="_blank">Open the original</a></p>
${draft.status !== 'pending' ? html`<p class="notice">This bill was already ${draft.status}${draft.saved_as ? html` as <a href="/bills/${enc(draft.saved_as)}">${draft.saved_as}</a>` : ''}.</p>` : ''}
${r.totalUsd ? html`<p class="small">The bill asks for <b>$${fmtMoney(r.totalUsd)}</b>${r.rmbPerUsd ? ` at ${r.rmbPerUsd} RMB per USD` : ''}. Record the payment against this bill once it’s saved.</p>` : ''}
${(r.lines || []).some((l) => l.kind === 'onward') ? onwardGuide(true) : ''}
${(r.checks || []).length ? html`<div class="card"><ul class="items">${r.checks.map((c) => html`<li><span class="sev ${c.severity === 'ok' ? 'info' : 'warning'}">${c.severity === 'ok' ? '✓' : '!'}</span><div style="flex:1">${c.message}</div></li>`)}</ul></div>` : ''}
${billForm(ctx, bill, { action: `/bills/drafts/${draft.id}/save`, submit: 'Save courier bill' })}
<p class="muted small">The date is the day the bill was sent (from the file name when it has one). The original is attached to the bill when you save.</p>
<form method="post" action="/bills/drafts/${draft.id}/discard" data-confirm="Discard this bill without saving it?"><button class="danger">Discard</button></form>
${r.sourceText ? html`<details><summary>What the Excel file says</summary><pre class="small" style="white-space:pre-wrap">${r.sourceText}</pre></details>` : ''}`;
  return { title: 'Check courier bill', body };
}

export function saveBillDraft(ctx) {
  const draft = loadBillDraft(ctx);
  const back = `/bills/drafts/${draft.id}`;
  if (draft.status !== 'pending') throw Object.assign(new HttpError(400, `This bill was already ${draft.status}`), { back });
  let bill;
  try {
    bill = billFromForm(ctx, null);
  } catch (err) {
    throw Object.assign(err, { back: err.back || back });
  }
  storeBill(ctx, bill);
  const file = path.resolve(ROOT, draft.file_path);
  if (fs.existsSync(file)) addAttachment(ctx.db, { entity: 'courier_bill', entityId: bill.id, buffer: fs.readFileSync(file), filename: draft.filename || `${bill.id}${path.extname(file)}`, actor: ctx.actor });
  closeBillDraft(ctx.db, draft.id, 'saved', bill.id);
  return { redirect: `/bills/${enc(bill.id)}?ok=${enc(`${bill.id} saved, with the bill attached.`)}` };
}

export function discardBillDraft(ctx) {
  const draft = loadBillDraft(ctx);
  closeBillDraft(ctx.db, draft.id, 'discarded');
  return { redirect: `/bills?ok=${enc('Discarded.')}` };
}

export function billDraftFile(ctx) {
  const draft = loadBillDraft(ctx);
  const file = path.resolve(ROOT, draft.file_path);
  // Only ever serve files from the invoice folder.
  if (!file.startsWith(path.resolve(INVOICE_DIR) + path.sep) || !fs.existsSync(file)) throw notFound('That file');
  return { body: fs.readFileSync(file), type: draft.mime || 'application/octet-stream', headers: { 'Content-Disposition': `inline; filename="${(draft.filename || 'bill').replace(/["\r\n]/g, '')}"` } };
}

export function deleteBill(ctx) {
  const existing = ctx.data.ledger.courierBills.find((b) => b.id === ctx.params[0]);
  if (existing) assertFresh(ctx, 'courier_bill', existing.id, existing, `/bills/${enc(existing.id)}`);
  if (!deleteRecord(ctx.db, 'courier_bill', ctx.params[0], { actor: ctx.actor })) throw notFound(`Courier bill ${ctx.params[0]}`);
  return { redirect: '/bills?ok=Bill+deleted.' };
}

function billForm(ctx, bill, { action, submit, version = '' }) {
  const { ledger } = ctx.data;
  const lines = [...(bill?.lines || [])];
  for (let i = 0; i < BLANK_LINES; i++) lines.push({});
  return html`<form class="card" method="post" action="${action}">
${version}
<div class="grid">
  <div><label>Agent (required)</label><input name="agent" value="${bill?.agent || 'Annie'}" required></div>
  <div><label>Date (required)</label><input type="date" name="date" value="${bill?.date || ''}" required></div>
  <div><label>Total on the bill, RMB (required)</label><input name="statedTotalRmb" inputmode="decimal" value="${bill?.statedTotalRmb || ''}" required></div>
  <div><label>Rate on the bill, RMB per USD (required)</label><input name="rmbPerUsd" inputmode="decimal" value="${bill?.rmbPerUsd || ''}" required></div>
</div>
<div class="scroll"><table class="rows" data-need-first><thead><tr><th>Kind</th><th>FBA shipment</th><th>RMB</th><th>Description</th></tr></thead><tbody>
${lines.map((l) => html`<tr><td>${select('line_kind', KINDS, l.kind || 'shipping')}</td><td><input name="line_shipment" list="shipments" value="${l.shipment || ''}" data-need="shipping domestic"></td>
<td><input name="line_rmb" inputmode="decimal" value="${l.rmb || ''}" data-need="any"></td><td><input name="line_description" value="${l.description || l.category || ''}" data-need="adjustment expense onward"></td></tr>`)}
</tbody></table></div>
<datalist id="shipments">${ledger.shipments.map((s) => html`<option value="${s.id}">`)}</datalist>
<p class="muted small"><b>Required on each line you use:</b> the RMB; for shipping and domestic shipping, the FBA shipment; for an adjustment or expense, what it is; for goods going to a 3PL or home, where (add their FBA shipment here once they go to Amazon: <a href="/bills#no-fba-id">how it works</a>). Put domestic shipping on its own shipment’s line. Fees and adjustments with no shipment are shared by RMB share. The bill’s total and rate are checked against its lines.</p>
<button>${submit}</button></form>`;
}
