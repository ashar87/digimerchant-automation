/**
 * Files posted in the supplier group (`files` in config/chats.json): Atif's
 * supplier invoices and the courier bills. Each photo or PDF is labelled by
 * Gemini, the pages of one document sent together are read as one, and the
 * result becomes a draft to check on the dashboard, exactly as an upload would.
 *
 * A corrected invoice sent later (same supplier invoice number) takes the
 * earlier one's place: a draft still waiting is set aside, and one already
 * saved to a PO is replaced by this version when it's saved. A corrected bill
 * (same shipments) does the same for a bill still waiting.
 */
import { loadLedger } from '../landing/store.js';
import { intakeInvoice, getDraft, INVOICE_DIR } from '../invoices/intake.js';
import { intakeBill, getBillDraft } from '../bills/intake.js';
import { enqueue } from '../notify/outbox.js';
import { fmtRmb } from '../landing/money.js';
import { config } from '../config.js';

const EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BILL_NAME = /bill|freight|shipping|courier|账单|运费/i;

const str = { type: 'STRING', nullable: true };
export const LABEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['supplier_invoice', 'courier_bill', 'payment', 'other'] },
    supplier: { ...str, description: 'Company that issued the invoice, as printed' },
    invoiceNumber: { ...str, description: 'Invoice / PI / order number as printed, else null' },
  },
  required: ['kind'],
};

const LABEL_SYSTEM = `You sort documents posted in a small Amazon seller's chat with its China sourcing partner.
- supplier_invoice: a factory or supplier's invoice, proforma invoice (PI), quotation with prices, or order confirmation for goods.
- courier_bill: a freight forwarder or courier's bill or statement for shipping cartons, usually listing FBA shipment IDs (FBA…), weights and amounts.
- payment: a bank or Wise transfer receipt or payment screenshot.
- other: anything else (product photos, packaging, labels, chat screenshots).
Copy the supplier name and invoice number only as printed; null if not printed.`;

/** Labels one photo or PDF with the configured Gemini provider (cheap model). Tests pass their own `label`. */
export function geminiLabeller(provider, model = config.geminiModel) {
  return {
    async label({ mime, data }) {
      const kind = mime === 'application/pdf' ? 'pdf' : 'image';
      const out = await provider.readJson({ system: LABEL_SYSTEM, text: 'What is this document?', attachments: [{ kind, mime, data }], schema: LABEL_SCHEMA, job: 'sort document', label: 'Supplier group file', model });
      return out.data;
    },
  };
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9一-鿿]/g, '');
const sameSupplier = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  return !x || !y || x.includes(y) || y.includes(x);
};

/**
 * Splits files sent together into documents: consecutive files of one kind are
 * pages of one document, unless both show an invoice number or supplier and
 * those differ. Excel files are always a document of their own.
 */
export function groupPages(files) {
  const groups = [];
  for (const f of files) {
    const last = groups.at(-1);
    const head = last?.files[0].label;
    const fresh =
      !last ||
      f.mime === EXCEL ||
      last.files[0].mime === EXCEL ||
      last.kind !== f.label.kind ||
      (head.invoiceNumber && f.label.invoiceNumber && norm(head.invoiceNumber) !== norm(f.label.invoiceNumber)) ||
      (head.supplier && f.label.supplier && !sameSupplier(head.supplier, f.label.supplier));
    if (fresh) groups.push({ kind: f.label.kind, files: [f] });
    else last.files.push(f);
  }
  return groups;
}

/** The invoice this one corrects: a draft still waiting, or one saved to a PO. Matched on the supplier's invoice number. */
export function findEarlierInvoice(db, draft, ledger = loadLedger(db)) {
  const number = norm(draft.reading.invoiceNumber);
  if (number.length < 3) return null;
  const supplier = draft.reading.supplier;
  const drafts = db.prepare("SELECT id FROM invoice_drafts WHERE id != ? AND status IN ('pending','saved') ORDER BY id DESC").all(draft.id).map((r) => getDraft(db, r.id));
  const hit = drafts.find((d) => norm(d.reading.invoiceNumber) === number && sameSupplier(d.reading.supplier, supplier));
  if (hit?.status === 'pending') return { draft: hit };
  const where = (id) => ledger.orders.find((o) => (o.invoices || []).some((i) => i.id === id));
  if (hit?.saved_as && where(hit.saved_as)) return { po: where(hit.saved_as).po, invoiceId: hit.saved_as };
  for (const o of ledger.orders) {
    const inv = [...(o.invoices || [])].reverse().find((i) => norm(i.supplierRef) === number && sameSupplier(i.supplier || o.supplier, supplier));
    if (inv) return { po: o.po, invoiceId: inv.id };
  }
  return null;
}

const shipmentsOf = (reading) => [...new Set((reading.lines || []).map((l) => l.shipment).filter(Boolean))].sort().join(',');

/** The bill this one corrects: a draft still waiting, or a saved bill, covering exactly the same shipments. */
export function findEarlierBill(db, draft, ledger = loadLedger(db)) {
  const key = shipmentsOf(draft.reading);
  if (!key) return null;
  const pending = db.prepare("SELECT id FROM bill_drafts WHERE id != ? AND status = 'pending' ORDER BY id DESC").all(draft.id).map((r) => getBillDraft(db, r.id));
  const hit = pending.find((d) => shipmentsOf(d.reading) === key);
  if (hit) return { draft: hit };
  const bill = ledger.courierBills.find((b) => shipmentsOf(b) === key);
  return bill ? { bill: bill.id } : null;
}

function setAside(db, table, oldId, newId) {
  db.prepare(`UPDATE ${table} SET status = 'discarded', replaced_by = ? WHERE id = ? AND status = 'pending'`).run(newId, oldId);
}

function saveReading(db, table, draft, extra = {}) {
  const sets = ['reading = @reading', ...Object.keys(extra).map((k) => `${k} = @${k}`)];
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id`).run({ id: draft.id, reading: JSON.stringify(draft.reading), ...extra });
}

const pageNote = (n) => (n > 1 ? ` (${n} pages)` : '');
const linkTo = (link, p) => (link ? `${link.replace(/\/$/, '')}${p}` : `Dashboard → ${p}`);
const problemsLine = (checks = []) => {
  const p = checks.filter((c) => c.severity !== 'ok');
  return p.length ? `⚠️ ${p.length} thing(s) to check, e.g. ${p[0].message}` : null;
};

async function invoiceFrom(db, group, { author, chatLabel, reader, dir, link }) {
  const [first, ...rest] = group.files;
  let draft = await intakeInvoice({ db, buffer: first.buffer, filename: first.filename, mime: first.mime, source: 'whatsapp', actor: author, reader, dir, pages: rest });
  const r = draft.reading;
  const earlier = findEarlierInvoice(db, draft);
  let corrects = null;
  if (earlier?.draft) {
    setAside(db, 'invoice_drafts', earlier.draft.id, draft.id);
    r.replaces = { draft: earlier.draft.id };
    saveReading(db, 'invoice_drafts', draft, draft.po || !earlier.draft.po ? {} : { po: earlier.draft.po });
    corrects = `↻ A corrected version: the earlier one waiting to be checked (invoice ${earlier.draft.id}) is set aside.`;
  } else if (earlier?.po) {
    r.replaces = { po: earlier.po, invoiceId: earlier.invoiceId };
    saveReading(db, 'invoice_drafts', draft, draft.po ? {} : { po: earlier.po });
    corrects = `↻ A corrected version of ${earlier.po}’s invoice: saving it replaces that one.`;
  }
  draft = getDraft(db, draft.id);
  const head = [draft.reading.supplier, draft.reading.invoiceNumber ? `no. ${draft.reading.invoiceNumber}` : null, draft.po].filter(Boolean).join(' · ');
  const text = [
    `🧾 Invoice from ${author} in ${chatLabel}${pageNote(group.files.length)}`,
    head || null,
    draft.reading.lines?.length ? `${draft.reading.lines.length} line(s)${draft.reading.statedTotalRmb ? `, total ${fmtRmb(draft.reading.statedTotalRmb)} RMB` : ''}` : 'Nothing could be read from it: type the lines in.',
    corrects,
    problemsLine(draft.reading.checks),
    `Check and save: ${linkTo(link, `/invoices/drafts/${draft.id}`)}`,
  ];
  enqueue(db, { kind: 'group_invoice', dedupeKey: `group:invoice:${draft.id}`, text: text.filter(Boolean).join('\n') });
  return { kind: 'invoice', draft, corrects: !!corrects };
}

async function billFrom(db, group, { author, chatLabel, reader, amazon, dir, link }) {
  const [first, ...rest] = group.files;
  let draft = await intakeBill({ db, buffer: first.buffer, filename: first.filename, mime: first.mime, source: 'whatsapp', actor: author, reader, amazon, dir, pages: rest });
  const earlier = findEarlierBill(db, draft);
  let corrects = null;
  if (earlier?.draft) {
    setAside(db, 'bill_drafts', earlier.draft.id, draft.id);
    draft.reading.replaces = { draft: earlier.draft.id };
    saveReading(db, 'bill_drafts', draft);
    corrects = `↻ A corrected version: the earlier one waiting to be checked (bill ${earlier.draft.id}) is set aside.`;
  } else if (earlier?.bill) {
    draft.reading.replaces = { bill: earlier.bill };
    saveReading(db, 'bill_drafts', draft);
    corrects = `ℹ️ Bill ${earlier.bill} already covers the same shipments. If this corrects it, fix ${earlier.bill} and discard this one.`;
  }
  draft = getBillDraft(db, draft.id);
  const shipments = shipmentsOf(draft.reading);
  const text = [
    `📦 Courier bill from ${author} in ${chatLabel}${pageNote(group.files.length)}`,
    draft.reading.lines?.length ? `${draft.reading.lines.length} line(s)${draft.reading.statedTotalRmb ? `, total ${fmtRmb(draft.reading.statedTotalRmb)} RMB` : ''}${shipments ? ` · ${shipments.split(',').join(', ')}` : ''}` : 'Nothing could be read from it: type the lines in.',
    corrects,
    problemsLine(draft.reading.checks),
    `Check and save: ${linkTo(link, `/bills/drafts/${draft.id}`)}`,
  ];
  enqueue(db, { kind: 'group_bill', dedupeKey: `group:bill:${draft.id}`, text: text.filter(Boolean).join('\n') });
  return { kind: 'bill', draft, corrects: !!corrects };
}

/**
 * Takes the files one person sent in a burst ([{ buffer, filename, mime }]),
 * labels, groups and reads them, and queues a card per document for the
 * self-chat. Payment screenshots and anything else are left alone. Returns
 * what happened to each document.
 */
export async function intakeGroupFiles({ db, files, author, chatLabel, labeller, invoiceReader = null, billReader = null, amazon = null, dir = INVOICE_DIR, link = config.dashboardUrl }) {
  const labelled = [];
  for (const f of files) {
    let label;
    if (f.mime === EXCEL) label = { kind: BILL_NAME.test(f.filename || '') ? 'courier_bill' : 'supplier_invoice' };
    else {
      try {
        label = await labeller.label({ mime: f.mime, data: f.buffer.toString('base64') });
      } catch (err) {
        // Unsure what it is: read it as an invoice, the more common of the two, rather than lose it.
        label = { kind: 'supplier_invoice', error: err.message };
      }
    }
    labelled.push({ ...f, label });
  }
  const out = [];
  for (const group of groupPages(labelled)) {
    try {
      if (group.kind === 'supplier_invoice') out.push(await invoiceFrom(db, group, { author, chatLabel, reader: invoiceReader, dir, link }));
      else if (group.kind === 'courier_bill') out.push(await billFrom(db, group, { author, chatLabel, reader: billReader, amazon, dir, link }));
      else out.push({ kind: group.kind, skipped: group.files.length });
    } catch (err) {
      out.push({ kind: group.kind, error: err.message });
      enqueue(db, { kind: 'group_error', text: `⚠️ Couldn’t take in ${group.kind === 'courier_bill' ? 'a courier bill' : 'an invoice'} from ${author} in ${chatLabel}: ${err.message}. Upload it on the dashboard instead.` });
    }
  }
  return out;
}

/**
 * Collects the files each person sends, and hands them over once they've been
 * quiet for `idleMs`: the pages of an invoice sent one photo at a time arrive
 * as one batch.
 */
export function createBursts({ idleMs = 90_000, onFlush }) {
  const open = new Map();
  const flush = async (key) => {
    const b = open.get(key);
    if (!b) return;
    open.delete(key);
    clearTimeout(b.timer);
    await onFlush(b.meta, b.files);
  };
  return {
    add(key, meta, file) {
      const b = open.get(key) || { meta, files: [] };
      b.files.push(file);
      clearTimeout(b.timer);
      b.timer = setTimeout(() => flush(key).catch(() => {}), idleMs);
      b.timer.unref?.();
      open.set(key, b);
    },
    flushAll: () => Promise.all([...open.keys()].map(flush)),
    get size() {
      return open.size;
    },
  };
}
