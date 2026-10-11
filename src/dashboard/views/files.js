// Documents on orders, invoices, payments and courier bills: upload, view in the browser, remove.
import fs from 'node:fs';
import path from 'node:path';
import { html } from '../html.js';
import { text } from '../forms.js';
import { HttpError, notFound } from '../errors.js';
import { enc } from './common.js';
import { ROOT } from '../../config.js';
import { INVOICE_DIR } from '../../invoices/intake.js';
import { ACCEPT, addAttachment, listAttachments, getAttachment, removeAttachment, readAttachment, contentDisposition, isInline } from '../../files/attachments.js';

const LABELS = { 'application/pdf': 'PDF', 'image/jpeg': 'Photo', 'image/png': 'Image', 'image/webp': 'Image', 'image/heic': 'Photo', 'text/csv': 'CSV', 'application/vnd.ms-excel': 'Excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word' };
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function safeBack(v) {
  const s = String(v || '');
  return /^\/(?![/\\])/.test(s) ? s : '/';
}

/** Whether the record a document is being attached to exists. */
function exists(ctx, entity, id) {
  const { ledger } = ctx.data;
  if (entity === 'order') return ledger.orders.some((o) => o.po === id);
  if (entity === 'invoice') return ledger.orders.some((o) => (o.invoices || []).some((i) => i.id === id));
  if (entity === 'payment') return ledger.payments.some((p) => p.id === id);
  if (entity === 'courier_bill') return ledger.courierBills.some((b) => b.id === id);
  return false;
}

/**
 * The Documents block for one record: what's attached (each opens in a new tab)
 * and a form to add more. `extra` lists files kept elsewhere, such as the
 * original of an invoice read from an upload.
 */
export function documentsSection(ctx, entity, id, { title = 'Documents', back, hint = '', extra = [], heading = true } = {}) {
  const files = listAttachments(ctx.db, entity, id);
  const rows = [
    ...extra.map((x) => html`<li><a href="${x.href}" target="_blank" rel="noopener">${x.label}</a> <span class="muted small">${x.meta || ''}</span></li>`),
    ...files.map(
      (a) => html`<li><a href="/files/${a.id}" target="_blank" rel="noopener">${a.filename}</a> <span class="muted small">${LABELS[a.mime] || 'File'} · ${size(a.size)} · ${a.uploaded_by}, ${day(a.uploaded_at)}${a.note ? html` · ${a.note}` : ''}${isInline(a.mime) ? '' : ' · downloads'}</span>
      <a class="small danger-link" href="/files/${a.id}/remove?back=${enc(back)}">Remove</a></li>`
    ),
  ];
  return html`${heading ? html`<h2>${title}</h2>` : ''}
${rows.length ? html`<ul class="docs">${rows}</ul>` : html`<p class="muted small">Nothing attached yet.</p>`}
<details class="small"><summary>Attach ${rows.length ? 'more' : 'a document'}</summary>
<form class="card" method="post" action="/files" enctype="multipart/form-data">
<input type="hidden" name="entity" value="${entity}"><input type="hidden" name="entity_id" value="${id}"><input type="hidden" name="back" value="${back}">
<label>Files (PDF, photos, Excel, CSV or Word; up to 15 MB each)</label><input type="file" name="file" accept="${ACCEPT}" multiple required>
<label>Note (optional)</label><input name="note" maxlength="200" placeholder="${hint}" style="width:100%">
<p><button>Attach</button></p></form></details>`;
}

export function uploadFiles(ctx) {
  const entity = text(ctx.form, 'entity');
  const id = text(ctx.form, 'entity_id');
  const back = safeBack(ctx.form.get('back'));
  if (!exists(ctx, entity, id)) throw Object.assign(new HttpError(400, `There's no ${String(entity).replace('_', ' ')} ${id} to attach to.`), { back });
  const files = ctx.files.filter((f) => f.name === 'file' && f.data?.length);
  if (!files.length) throw Object.assign(new HttpError(400, 'Choose a file to attach.'), { back });
  for (const f of files) {
    try {
      addAttachment(ctx.db, { entity, entityId: id, buffer: f.data, filename: f.filename, note: text(ctx.form, 'note'), actor: ctx.actor });
    } catch (err) {
      throw Object.assign(new HttpError(400, `${f.filename}: ${err.message}`), { back });
    }
  }
  const u = new URL(back, 'http://x');
  u.searchParams.set('ok', `${files.length} document${files.length === 1 ? '' : 's'} attached.`);
  return { redirect: u.pathname + u.search };
}

function serve(read, filename) {
  return {
    body: read.body,
    type: read.type,
    headers: { 'Content-Disposition': contentDisposition(read.disposition, filename), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' },
  };
}

export function fileView(ctx) {
  const a = getAttachment(ctx.db, Number(ctx.params[0]));
  const read = a && readAttachment(a);
  if (!read) throw notFound('That document');
  return serve(read, a.filename);
}

export function removeFilePage(ctx) {
  const a = getAttachment(ctx.db, Number(ctx.params[0]));
  if (!a) throw notFound('That document');
  const back = safeBack(ctx.url.searchParams.get('back'));
  return {
    title: 'Remove document?',
    body: html`<h1>Remove ${a.filename}?</h1><p>It comes off ${a.entity.replace('_', ' ')} ${a.entity_id}. The removal is recorded in the history.</p>
<form method="post" action="/files/${a.id}/remove"><input type="hidden" name="back" value="${back}"><button class="danger">Remove document</button> <a href="${back}">Keep it</a></form>`,
  };
}

export function removeFile(ctx) {
  const back = safeBack(ctx.form.get('back'));
  if (!removeAttachment(ctx.db, Number(ctx.params[0]), { actor: ctx.actor })) throw notFound('That document');
  const u = new URL(back, 'http://x');
  u.searchParams.set('ok', 'Document removed.');
  return { redirect: u.pathname + u.search };
}

/** The original file an invoice was read from (an upload, or forwarded on WhatsApp). */
export function invoiceFile(ctx) {
  const order = ctx.data.ledger.orders.find((o) => o.po === ctx.params[0]);
  const inv = order?.invoices?.find((i) => i.id === ctx.params[1]);
  if (!inv?.filePath) throw notFound('That invoice file');
  const file = path.resolve(ROOT, inv.filePath);
  if (!file.startsWith(path.resolve(INVOICE_DIR) + path.sep) || !fs.existsSync(file)) throw notFound('That invoice file');
  const ext = path.extname(file).toLowerCase();
  const type = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
  return serve({ body: fs.readFileSync(file), type, disposition: isInline(type) ? 'inline' : 'attachment' }, `${order.po} ${inv.kind} invoice${ext}`);
}
