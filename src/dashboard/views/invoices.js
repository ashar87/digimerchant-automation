import fs from 'node:fs';
import { html, select } from '../html.js';
import { saveLedger, nextPo } from '../../landing/store.js';
import { intakeInvoice, getDraft, pendingDrafts, closeDraft, draftFilePath } from '../../invoices/intake.js';
import { text, required, compact } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { MARKETPLACES, enc, supplierList, supplierOptions } from './common.js';
import { invoiceForm, invoiceFromForm } from './orders.js';
import { versionField, assertFresh } from '../versions.js';
import { addAttachment } from '../../files/attachments.js';
import { fmtMoney } from '../../landing/money.js';

const METHOD = { excel: 'Read exactly from the Excel file.', model: 'Read by Gemini. Anything it couldn’t read is left blank, never guessed.', none: 'Not read automatically.', failed: 'Reading failed.' };

export function invoicesPage(ctx) {
  const drafts = pendingDrafts(ctx.db);
  const body = html`
<h1>Invoices</h1>
<p class="sub">Invoices Atif posts in the supplier group on WhatsApp arrive here by themselves; anything else, upload. Excel is read exactly; PDFs and photos are read by Gemini. Either way you check it before it’s saved, and a corrected version sent later takes the earlier one’s place.</p>
<form class="card" method="post" action="/invoices/upload" enctype="multipart/form-data">
<div class="grid">
  <div><label>Invoice file (Excel, PDF or photo)</label><input type="file" name="file" required accept=".xlsx,.pdf,.jpg,.jpeg,.png,.webp,.heic"></div>
  <div><label>PO number, if you know it</label><input name="po" list="pos" placeholder="${nextPo(ctx.db)}"></div>
</div>
<datalist id="pos">${ctx.data.ledger.orders.map((o) => html`<option value="${o.po}">${o.supplier}</option>`)}</datalist>
<button>Read invoice</button>${ctx.invoiceReader ? '' : html` <span class="muted small">Gemini reading isn’t set up here, so PDFs and photos will need their lines typed in.</span>`}
</form>
<h2>Waiting to be checked (${drafts.length})</h2>
${drafts.length
  ? html`<div class="card"><ul class="items">${drafts.map((d) => html`<li><div><a href="/invoices/drafts/${d.id}">${d.filename || `Invoice ${d.id}`}</a>${d.po ? ` · ${d.po}` : ''}
  <div class="muted small">${d.source === 'whatsapp' ? `From ${d.created_by} on WhatsApp` : `Uploaded by ${d.created_by}`}${d.reading.replaces ? ' · corrected version' : ''} · ${d.created_at.slice(0, 16).replace('T', ' ')} · ${d.reading.lines?.length || 0} line(s)</div></div></li>`)}</ul></div>`
  : html`<p class="muted">None.</p>`}`;
  return { title: 'Invoices', body };
}

export async function uploadInvoice(ctx) {
  const file = ctx.files.find((f) => f.name === 'file');
  if (!file) throw new HttpError(400, 'Choose a file to upload');
  const po = text(ctx.form, 'po')?.toUpperCase() || null;
  try {
    const draft = await intakeInvoice({ db: ctx.db, buffer: file.data, filename: file.filename, mime: file.mime, source: 'upload', actor: ctx.actor, po, reader: ctx.invoiceReader });
    return { redirect: `/invoices/drafts/${draft.id}` };
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

function loadDraft(ctx) {
  const draft = getDraft(ctx.db, Number(ctx.params[0]));
  if (!draft) throw notFound(`Invoice ${ctx.params[0]}`);
  return draft;
}

export function draftPage(ctx) {
  const draft = loadDraft(ctx);
  const r = draft.reading;
  const { ledger } = ctx.data;
  // ?po= opens the page on another PO (picked below), so its invoices can be chosen in "This invoice…".
  const picked = ctx.url.searchParams.get('po')?.trim().toUpperCase() || null;
  const po = picked || draft.po;
  const existing = po ? ledger.orders.find((o) => o.po === po) : null;
  const order = existing || { po: po || nextPo(ctx.db), marketplace: r.marketplace || undefined, invoices: [] };
  // A corrected version, or the balance invoice, of an invoice already on this PO: saving it replaces that one.
  const replaced = r.replaces?.po === order.po ? (existing?.invoices || []).find((i) => i.id === r.replaces.invoiceId) : null;
  const inv = {
    kind: replaced ? (replaced.kind === 'final' ? 'final' : r.kindGuess || 'proforma') : existing?.invoices?.length ? 'final' : r.kindGuess || 'proforma',
    date: r.date,
    // No invoice number printed: the order's date and market stand in for it, so later invoices for the order find this one.
    supplierRef: r.invoiceNumber || r.orderRef,
    statedTotalRmb: r.statedTotalRmb,
    lines: (r.lines || []).map((l) => ({ kind: l.kind, product: l.product, qty: l.qty, rmb: l.rmb, description: l.description })),
  };
  if (replaced) inv.seriesChoice = replaced.series || 'main';
  const balance = replaced && replaced.kind === 'proforma' && inv.kind === 'final';
  const pages = r.pages?.length ? html` · pages ${[0, ...r.pages.map((_, i) => i + 1)].map((n) => html`<a href="/invoices/drafts/${draft.id}/file?page=${n}">${n + 1}</a> `)}` : '';
  // The name as read off the invoice, matched to the list where one fits ("NANJING YONGBO CO." → Nanjing Yongbo).
  const read = (r.supplier || '').toLowerCase();
  const supplier = existing?.supplier || (read && supplierList(ctx).find((n) => read.includes(n.toLowerCase()) || n.toLowerCase().includes(read))) || r.supplier || '';
  const head = html`<div class="grid">
  <div><label>PO number (required)</label><input name="po" value="${order.po}" list="pos" required pattern="PO-\\d+"></div>
  <div><label>Supplier (for a new PO)</label>${select('supplier', supplierOptions(ctx, supplier), supplier, { blank: true })}</div>
  <div><label>Marketplace (for a new PO)</label>${select('marketplace', MARKETPLACES, existing?.marketplace || r.marketplace || 'UK')}</div>
</div>
<datalist id="pos">${ledger.orders.map((o) => html`<option value="${o.po}">${o.supplier} · ${o.marketplace}</option>`)}</datalist>`;

  const body = html`
<p class="muted small"><a href="/invoices">Invoices</a></p>
<h1>Check before saving</h1>
<p class="sub">${draft.filename || 'Invoice'}${draft.source === 'whatsapp' ? ` · from ${draft.created_by} on WhatsApp` : ''} · ${METHOD[r.method] || ''} <a href="/invoices/drafts/${draft.id}/file">Open the original</a>${pages}</p>
${draft.replaced_by ? html`<p class="notice">A corrected version came in later: <a href="/invoices/drafts/${draft.replaced_by}">invoice ${draft.replaced_by}</a>. This one was set aside.</p>` : ''}
${r.replaces?.draft ? html`<p class="notice">A corrected version of <a href="/invoices/drafts/${r.replaces.draft}">invoice ${r.replaces.draft}</a>, which was set aside.</p>` : ''}
${replaced
  ? balance
    ? html`<p class="notice">The balance invoice for ${order.po}${r.orderRef ? ` (order ${r.orderRef})` : ''}. Saving it replaces the deposit invoice (${replaced.date || 'undated'}), which stays in the PO’s history.</p>`
    : html`<p class="notice">A corrected version of ${order.po}’s invoice${replaced.supplierRef ? ` ${replaced.supplierRef}` : ''} (${replaced.kind}, ${replaced.date || 'undated'}). Saving it replaces that one; the earlier version stays in the PO’s history.</p>`
  : ''}
${r.sameOrder?.draft ? html`<p class="notice">The ${r.kindGuess === 'final' ? 'balance' : 'deposit'} invoice for the same order as <a href="/invoices/drafts/${r.sameOrder.draft}">invoice ${r.sameOrder.draft}</a>, which is still waiting to be checked: save that one first.</p>` : ''}
${!existing && !r.replaces && r.orderRef ? html`<p class="small">A new order (${r.orderRef}, from the invoice’s Date column), so a new PO. ${r.orderRef} is kept as the supplier ref: the corrected versions and the balance invoice for this order will find this PO by it.</p>` : ''}
${r.payUsd ? html`<p class="small">The invoice asks for <b>$${fmtMoney(r.payUsd)}</b> now${r.rmbPerUsd ? ` at ${r.rmbPerUsd} RMB per USD` : ''}.</p>` : ''}
${r.marketplaceAsPrinted ? html`<p class="small">Marketplace printed on the invoice: <b>${r.marketplaceAsPrinted}</b> (suppliers sometimes print the wrong one).</p>` : ''}
${r.notes ? html`<p class="notice">${r.notes}</p>` : ''}
<div class="card"><ul class="items">${(r.checks || []).map((c) => html`<li><span class="sev ${c.severity === 'ok' ? 'info' : 'warning'}">${c.severity === 'ok' ? '✓' : '!'}</span><div style="flex:1">${c.message}</div></li>`)}</ul></div>
${draft.status === 'pending' && ledger.orders.length
  ? html`<form class="card" method="get" action="/invoices/drafts/${draft.id}"><label for="pick-po"><b>${existing ? `Saving to ${existing.po}.` : 'Saving to a new PO.'}</b> For an order already on the dashboard (e.g. its deposit invoice), use its PO:</label>
${select('po', [{ value: '', label: '— choose a PO —' }, ...[...ledger.orders].reverse().map((o) => ({ value: o.po, label: `${o.po} · ${o.supplier || ''} · ${o.marketplace || ''}${o.invoices?.length ? ` · ${o.invoices.length} invoice(s)` : ''}` }))], existing?.po || '', { attrs: 'id="pick-po"' })} <button class="ghost">Use this PO</button></form>`
  : ''}
${draft.status === 'pending'
  ? html`${invoiceForm(ctx, order, inv, { action: `/invoices/drafts/${draft.id}/save`, submit: 'Save to this PO', head, version: html`${versionField(existing)}<input type="hidden" name="version_po" value="${order.po}">` })}
<form method="post" action="/invoices/drafts/${draft.id}/discard"><button class="danger">Discard</button></form>`
  : draft.replaced_by ? '' : html`<p class="notice">This invoice was already ${draft.status}${draft.saved_as ? ` as ${draft.saved_as}` : ''}.</p>`}
${r.sourceText ? html`<details><summary>What the Excel file says</summary><pre class="small" style="white-space:pre-wrap">${r.sourceText}</pre></details>` : ''}`;
  return { title: 'Check invoice', body };
}

export function saveDraft(ctx) {
  const draft = loadDraft(ctx);
  if (draft.status !== 'pending') throw new HttpError(400, `This invoice was already ${draft.status}`);
  const f = ctx.form;
  const po = required(text(f, 'po'), 'PO number').toUpperCase();
  if (!/^PO-\d+$/.test(po)) throw new HttpError(400, 'PO numbers look like PO-020');
  const { ledger } = ctx.data;
  const current = ledger.orders.find((o) => o.po === po) || null;
  // Only the PO the page was opened on can be stale; choosing another one here is a fresh choice.
  if (po === f.get('version_po')) assertFresh(ctx, 'order', po, current, `/invoices/drafts/${draft.id}`);
  let order = structuredClone(current);
  if (!order) {
    const marketplace = text(f, 'marketplace');
    if (!MARKETPLACES.includes(marketplace)) throw new HttpError(400, 'Choose UK, DE or US for the new PO');
    order = compact({ po, supplier: required(text(f, 'supplier'), 'Supplier (for a new PO)'), marketplace, invoices: [] });
    order.invoices = [];
  }
  const invoice = invoiceFromForm(f, order, ledger, null, { filePath: draft.file_path });
  order.invoices = [...(order.invoices || []), invoice];
  saveLedger(ctx.db, { orders: [order] }, { actor: ctx.actor });
  // Further pages of a photographed invoice go on as its documents.
  (draft.reading.pages || []).forEach((_, i) => {
    const file = draftFilePath(draft, i + 1);
    if (file) addAttachment(ctx.db, { entity: 'invoice', entityId: invoice.id, buffer: fs.readFileSync(file), filename: `${invoice.id} page ${i + 2}${file.slice(file.lastIndexOf('.'))}`, actor: ctx.actor });
  });
  closeDraft(ctx.db, draft.id, 'saved', invoice.id);
  return { redirect: `/orders/${enc(po)}?ok=${enc(`Invoice saved to ${po}.`)}` };
}

export function discardDraft(ctx) {
  const draft = loadDraft(ctx);
  closeDraft(ctx.db, draft.id, 'discarded');
  return { redirect: '/invoices?ok=Discarded.' };
}

export function draftFile(ctx) {
  const draft = loadDraft(ctx);
  const page = Number(ctx.url.searchParams.get('page') || 0);
  const file = draftFilePath(draft, page);
  if (!file) throw notFound('That file');
  if (page) return { body: fs.readFileSync(file), type: mimeOf(file), headers: { 'Content-Disposition': 'inline' } };
  return { body: fs.readFileSync(file), type: draft.mime || 'application/octet-stream', headers: { 'Content-Disposition': `inline; filename="${(draft.filename || 'invoice').replace(/["\r\n]/g, '')}"` } };
}


const mimeOf = (file) => ({ '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic' })[file.slice(file.lastIndexOf('.')).toLowerCase()] || 'image/jpeg';
