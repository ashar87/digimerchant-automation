import fs from 'node:fs';
import path from 'node:path';
import { html, select } from '../html.js';
import { saveLedger, nextPo } from '../../landing/store.js';
import { ROOT } from '../../config.js';
import { intakeInvoice, getDraft, pendingDrafts, closeDraft, INVOICE_DIR } from '../../invoices/intake.js';
import { text, required, compact } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { MARKETPLACES, enc } from './common.js';
import { invoiceForm, invoiceFromForm } from './orders.js';
import { versionField, assertFresh } from '../versions.js';

const METHOD = { excel: 'Read exactly from the Excel file.', model: 'Read by Gemini. Anything it couldn’t read is left blank, never guessed.', none: 'Not read automatically.', failed: 'Reading failed.' };

export function invoicesPage(ctx) {
  const drafts = pendingDrafts(ctx.db);
  const body = html`
<h1>Invoices</h1>
<p class="sub">Upload a proforma or final invoice, or forward it to your WhatsApp self-chat with the caption “invoice PO-020”. Excel is read exactly; PDFs and photos are read by Gemini. Either way you check it before it’s saved.</p>
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
  <div class="muted small">${d.source === 'whatsapp' ? 'Forwarded on WhatsApp' : `Uploaded by ${d.created_by}`} · ${d.created_at.slice(0, 16).replace('T', ' ')} · ${d.reading.lines?.length || 0} line(s)</div></div></li>`)}</ul></div>`
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
  const existing = draft.po ? ledger.orders.find((o) => o.po === draft.po) : null;
  const order = existing || { po: draft.po || nextPo(ctx.db), marketplace: r.marketplace || undefined, invoices: [] };
  const inv = {
    kind: existing?.invoices?.length ? 'final' : r.kindGuess || 'proforma',
    date: r.date,
    supplierRef: r.invoiceNumber,
    statedTotalRmb: r.statedTotalRmb,
    lines: (r.lines || []).map((l) => ({ kind: l.kind, product: l.product, qty: l.qty, rmb: l.rmb, description: l.description })),
  };
  const head = html`<div class="grid">
  <div><label>PO number (required)</label><input name="po" value="${order.po}" list="pos" required pattern="PO-\\d+"></div>
  <div><label>Supplier (for a new PO)</label><input name="supplier" value="${existing?.supplier || r.supplier || ''}"></div>
  <div><label>Marketplace (for a new PO)</label>${select('marketplace', MARKETPLACES, existing?.marketplace || r.marketplace || 'UK')}</div>
</div>
<datalist id="pos">${ledger.orders.map((o) => html`<option value="${o.po}">${o.supplier} · ${o.marketplace}</option>`)}</datalist>`;

  const body = html`
<p class="muted small"><a href="/invoices">Invoices</a></p>
<h1>Check before saving</h1>
<p class="sub">${draft.filename || 'Invoice'} · ${METHOD[r.method] || ''} <a href="/invoices/drafts/${draft.id}/file">Open the original</a></p>
${r.marketplaceAsPrinted ? html`<p class="small">Marketplace printed on the invoice: <b>${r.marketplaceAsPrinted}</b> (suppliers sometimes print the wrong one).</p>` : ''}
${r.notes ? html`<p class="notice">${r.notes}</p>` : ''}
<div class="card"><ul class="items">${(r.checks || []).map((c) => html`<li><span class="sev ${c.severity === 'ok' ? 'info' : 'warning'}">${c.severity === 'ok' ? '✓' : '!'}</span><div style="flex:1">${c.message}</div></li>`)}</ul></div>
${invoiceForm(ctx, order, inv, { action: `/invoices/drafts/${draft.id}/save`, submit: 'Save to this PO', head, version: html`${versionField(existing)}<input type="hidden" name="version_po" value="${order.po}">` })}
<form method="post" action="/invoices/drafts/${draft.id}/discard"><button class="danger">Discard</button></form>
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
  const file = path.resolve(ROOT, draft.file_path);
  // Only ever serve files from the invoice folder.
  if (!file.startsWith(path.resolve(INVOICE_DIR) + path.sep) || !fs.existsSync(file)) throw notFound('That file');
  return { body: fs.readFileSync(file), type: draft.mime || 'application/octet-stream', headers: { 'Content-Disposition': `inline; filename="${(draft.filename || 'invoice').replace(/["\r\n]/g, '')}"` } };
}

