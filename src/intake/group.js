/**
 * Files posted in the supplier group (`files` in config/chats.json): Atif's
 * supplier invoices and the courier bills, each a screenshot of Annie's sheet.
 * Each photo is one document unless Gemini sees it continues the one before;
 * each becomes a draft to check on the dashboard, exactly as an upload would,
 * and everything one person sent together is summed up in one card.
 *
 * The suppliers print no invoice number, but every row of their sheet carries
 * the order's date and market ("2026/10/5-UK 英国"): the deposit invoice, its
 * corrected versions and the balance invoice share it, so it identifies the
 * order (orderRef). A file sent as a reply to an earlier one, or to the
 * feedback on it, is that one's corrected version. A corrected version takes
 * the earlier one's place: a draft still waiting is set aside, and one already
 * saved to a PO is replaced by this version when it's saved. A balance invoice
 * goes to its deposit invoice's PO and replaces it there.
 */
import { loadLedger, nextPo } from '../landing/store.js';
import { intakeInvoice, getDraft, INVOICE_DIR } from '../invoices/intake.js';
import { intakeBill, getBillDraft } from '../bills/intake.js';
import { enqueue } from '../notify/outbox.js';
import { D, fmtRmb } from '../landing/money.js';
import { fmtAmount } from './requests.js';
import { config } from '../config.js';

const EXCEL = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BILL_NAME = /bill|freight|shipping|courier|账单|运费/i;

export const LABEL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['supplier_invoice', 'courier_bill', 'payment', 'other'] },
    continuation: { type: 'BOOLEAN', description: 'True only if this is a later page of a document whose title and header row are on another picture' },
  },
  required: ['kind'],
};

const LABEL_SYSTEM = `You sort documents posted in a small Amazon seller's chat with its China sourcing partner. Most are screenshots of spreadsheets.
- supplier_invoice: a factory or supplier's invoice, proforma invoice (PI), quotation with prices or order confirmation for goods or packaging, or a sheet of other fees (samples, service fees, inspection).
- courier_bill: a freight forwarder or courier's bill ("shipping fee bills"), listing FBA shipment IDs, tracking numbers, weights and amounts.
- payment: a bank or Wise transfer receipt or payment screenshot.
- other: anything else (product photos, packaging, labels, chat screenshots).
Each picture is usually a whole document of its own; say continuation only when it plainly has no title or header row of its own.`;

/** Labels one photo or PDF with the configured Gemini provider. Tests pass their own `label`. */
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
 * Splits files sent together into documents: each file is one, unless the
 * labeller says it continues the document before it (same kind). Excel files
 * are always a document of their own.
 */
export function groupPages(files) {
  const groups = [];
  for (const f of files) {
    const last = groups.at(-1);
    const joins = last && f.label.continuation && last.kind === f.label.kind && f.mime !== EXCEL && last.files[0].mime !== EXCEL;
    if (joins) last.files.push(f);
    else groups.push({ kind: f.label.kind, files: [f] });
  }
  return groups;
}

const savedDrafts = (db, table, get, exceptId) =>
  db.prepare(`SELECT id FROM ${table} WHERE id != ? AND status IN ('pending','saved') ORDER BY id DESC`).all(exceptId).map((r) => get(db, r.id));
const fromMessage = (db, table, get, messageId, exceptId) => {
  const row = db.prepare(`SELECT id FROM ${table} WHERE message_id = ? AND id != ? AND status IN ('pending','saved') ORDER BY id DESC`).get(messageId, exceptId);
  return row ? get(db, row.id) : null;
};

/**
 * The invoice this one follows, or null:
 *   { draft, how }            a draft still waiting
 *   { po, invoiceId, how }    an invoice saved to a PO
 * `how`: 'reply' (sent as a reply to it, or to the feedback on it), 'ref' (same
 * invoice number or order, from the same supplier) or 'date' (an invoice typed
 * in by hand for the same supplier, market and order date).
 */
export function findEarlierInvoice(db, draft, { repliesTo = [] } = {}, ledger = loadLedger(db)) {
  const r = draft.reading;
  const orderOf = (id) => ledger.orders.find((o) => (o.invoices || []).some((i) => i.id === id));
  const asFound = (d, how) => {
    if (d.status === 'pending') return { draft: d, how };
    const o = d.saved_as && orderOf(d.saved_as);
    return o ? { po: o.po, invoiceId: d.saved_as, how } : null;
  };
  for (const id of repliesTo) {
    const d = fromMessage(db, 'invoice_drafts', getDraft, id, draft.id);
    const found = d && asFound(d, 'reply');
    if (found) return found;
  }

  const refOf = (x) => norm(x.invoiceNumber || x.orderRef);
  const ref = refOf(r);
  if (ref.length < 3) return null;
  const hit = savedDrafts(db, 'invoice_drafts', getDraft, draft.id).find((d) => refOf(d.reading) === ref && sameSupplier(d.reading.supplier, r.supplier));
  const found = hit && asFound(hit, 'ref');
  if (found) return found;
  for (const o of [...ledger.orders].reverse()) {
    const inv = [...(o.invoices || [])].reverse().find((i) => norm(i.supplierRef) === ref && sameSupplier(i.supplier || o.supplier, r.supplier));
    if (inv) return { po: o.po, invoiceId: inv.id, how: 'ref' };
  }
  if (!r.orderDate || !r.marketplace) return null;
  for (const o of [...ledger.orders].reverse()) {
    if (o.marketplace !== r.marketplace) continue;
    const inv = [...(o.invoices || [])].reverse().find((i) => i.date === r.orderDate && sameSupplier(i.supplier || o.supplier, r.supplier));
    if (inv) return { po: o.po, invoiceId: inv.id, how: 'date' };
  }
  return null;
}

const shipmentsOf = (reading) => [...new Set((reading.lines || []).map((l) => l.shipment).filter(Boolean))].sort().join(',');
const trackingOf = (reading) => (reading.tracking || []).join(',');

/**
 * The bill this one corrects: one it was sent as a reply to (or to the
 * feedback on), else a draft or saved bill with the same shipments or the same
 * tracking numbers (the FBA IDs may be what was wrong).
 */
export function findEarlierBill(db, draft, { repliesTo = [] } = {}, ledger = loadLedger(db)) {
  const asFound = (d, how) => (d.status === 'pending' ? { draft: d, how } : d.saved_as ? { bill: d.saved_as, how } : null);
  for (const id of repliesTo) {
    const d = fromMessage(db, 'bill_drafts', getBillDraft, id, draft.id);
    const found = d && asFound(d, 'reply');
    if (found) return found;
  }
  const key = shipmentsOf(draft.reading);
  const tracking = trackingOf(draft.reading);
  if (!key && !tracking) return null;
  const hit = savedDrafts(db, 'bill_drafts', getBillDraft, draft.id).find((d) => (key && shipmentsOf(d.reading) === key) || (tracking && trackingOf(d.reading) === tracking));
  const found = hit && asFound(hit, 'same');
  if (found) return found;
  const bill = key && ledger.courierBills.find((b) => shipmentsOf(b) === key);
  return bill ? { bill: bill.id, how: 'same' } : null;
}

function setAside(db, table, oldId, newId) {
  db.prepare(`UPDATE ${table} SET status = 'discarded', replaced_by = ? WHERE id = ? AND status = 'pending'`).run(newId, oldId);
}

function saveReading(db, table, draft, extra = {}) {
  const sets = ['reading = @reading', ...Object.keys(extra).map((k) => `${k} = @${k}`)];
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id`).run({ id: draft.id, reading: JSON.stringify(draft.reading), ...extra });
}

const linkTo = (link, p) => (link ? `${link.replace(/\/$/, '')}${p}` : `Dashboard → ${p}`);
const problemsLine = (checks = []) => {
  const p = checks.filter((c) => c.severity !== 'ok');
  return p.length ? `⚠️ ${p.length} thing(s) to check, e.g. ${p[0].message}` : null;
};
const stageOf = (kind) => (kind === 'final' ? 'balance' : 'deposit');
const asReply = (how) => (how === 'reply' ? ' (sent as a reply to it)' : '');

async function invoiceFrom(db, group, { author, reader, dir }) {
  const [first, ...rest] = group.files;
  let draft = await intakeInvoice({ db, buffer: first.buffer, filename: first.filename, mime: first.mime, source: 'whatsapp', actor: author, reader, dir, pages: rest, messageId: first.messageId || null });
  const r = draft.reading;
  const ledger = loadLedger(db);
  const earlier = findEarlierInvoice(db, draft, { repliesTo: group.files.flatMap((f) => f.repliesTo || []) }, ledger);
  let note = null;
  if (earlier?.draft) {
    const old = earlier.draft;
    const po = draft.po || !old.po ? {} : { po: old.po };
    if (earlier.how === 'reply' || (old.reading.kindGuess || 'proforma') === (r.kindGuess || 'proforma')) {
      setAside(db, 'invoice_drafts', old.id, draft.id);
      r.replaces = { draft: old.id };
      note = `↻ Corrects invoice ${old.id}${asReply(earlier.how)}, which is set aside.`;
    } else {
      r.sameOrder = { draft: old.id };
      note = `The ${stageOf(old.reading.kindGuess)} invoice for this order (invoice ${old.id}) is still waiting to be checked: save that one first.`;
    }
    saveReading(db, 'invoice_drafts', draft, po);
  } else if (earlier?.po) {
    const inv = ledger.orders.find((o) => o.po === earlier.po).invoices.find((i) => i.id === earlier.invoiceId);
    r.replaces = { po: earlier.po, invoiceId: earlier.invoiceId };
    saveReading(db, 'invoice_drafts', draft, draft.po ? {} : { po: earlier.po });
    note =
      earlier.how !== 'reply' && inv.kind === 'proforma' && r.kindGuess === 'final'
        ? `For ${earlier.po}: the balance invoice, replacing the deposit invoice when saved.`
        : `↻ Corrects ${earlier.po}’s ${stageOf(inv.kind)} invoice${asReply(earlier.how)}: saving it replaces that one.`;
  } else if (r.lines?.length) note = `A new order${r.orderRef ? ` (${r.orderRef})` : ''}: save it to a new PO, ${nextPo(db)} being next.`;
  draft = getDraft(db, draft.id);
  return { kind: 'invoice', draft, note, usd: draft.reading.payUsd || null, corrects: !!draft.reading.replaces };
}

async function billFrom(db, group, { author, reader, amazon, dir }) {
  const [first, ...rest] = group.files;
  let draft = await intakeBill({ db, buffer: first.buffer, filename: first.filename, mime: first.mime, source: 'whatsapp', actor: author, reader, amazon, dir, pages: rest, messageId: first.messageId || null });
  const earlier = findEarlierBill(db, draft, { repliesTo: group.files.flatMap((f) => f.repliesTo || []) });
  let note = null;
  if (earlier?.draft) {
    setAside(db, 'bill_drafts', earlier.draft.id, draft.id);
    draft.reading.replaces = { draft: earlier.draft.id };
    saveReading(db, 'bill_drafts', draft);
    note = `↻ Corrects bill ${earlier.draft.id}${asReply(earlier.how)}, which is set aside.`;
  } else if (earlier?.bill) {
    draft.reading.replaces = { bill: earlier.bill, how: earlier.how };
    saveReading(db, 'bill_drafts', draft);
    note = earlier.how === 'reply' ? `↻ Corrects ${earlier.bill}, already saved: fix ${earlier.bill} from this one, then discard it.` : `ℹ️ ${earlier.bill} already covers the same shipments. If this corrects it, fix ${earlier.bill} and discard this one.`;
  }
  draft = getBillDraft(db, draft.id);
  return { kind: 'bill', draft, note, usd: draft.reading.totalUsd || null, corrects: !!draft.reading.replaces };
}

/** One document's lines on the card. */
function describe(o, i, link) {
  const r = o.draft?.reading;
  const usd = o.usd ? fmtAmount('USD', o.usd) : null;
  if (o.kind === 'invoice') {
    const what = r.lines?.length ? [r.supplier, r.orderRef ? `order ${r.orderRef}` : null, usd ? `${stageOf(r.kindGuess)} ${usd}` : null].filter(Boolean).join(' · ') : 'nothing could be read from it: type the lines in';
    return [`${i}. Invoice: ${what}`, o.note, problemsLine(r.checks), `Check and save: ${linkTo(link, `/invoices/drafts/${o.draft.id}`)}`];
  }
  const shipments = shipmentsOf(r);
  const what = r.lines?.length ? [`${r.lines.length} line(s)`, r.statedTotalRmb ? `${fmtRmb(r.statedTotalRmb)} RMB` : null, shipments ? shipments.split(',').join(', ') : null, usd].filter(Boolean).join(' · ') : 'nothing could be read from it: type the lines in';
  return [`${i}. Courier bill: ${what}`, o.note, problemsLine(r.checks), `Check and save: ${linkTo(link, `/bills/drafts/${o.draft.id}`)}`];
}

/** Whether the documents add up to what Atif asked to be sent. */
function askedLine(docs, asked, author) {
  if (!asked || asked.currency !== 'USD' || !docs.length) return null;
  const missing = docs.findIndex((o) => !o.usd);
  if (missing >= 0) return `Couldn’t check the ${fmtAmount('USD', asked.amount)} ${author} asked for: no USD amount read on document ${missing + 1}.`;
  const total = docs.reduce((t, o) => t.plus(o.usd), D(0));
  const sumText = docs.length > 1 ? `${docs.map((o) => fmtAmount('USD', o.usd)).join(' + ')} = ${fmtAmount('USD', total)}` : fmtAmount('USD', total);
  return total.minus(asked.amount).abs().lt(1) ? `✓ ${sumText}, as ${author} asked.` : `⚠️ The documents ask for ${sumText}, but ${author} asked for ${fmtAmount('USD', asked.amount)}.`;
}

/**
 * Takes the files one person sent together ([{ buffer, filename, mime,
 * messageId, repliesTo }]), labels and reads them, and queues one card for the
 * self-chat covering every invoice and bill among them, checked against the
 * amount they asked to be sent (`asked`, { currency, amount }) when they said.
 * Payment screenshots and anything else are left alone. Returns what happened
 * to each document.
 */
export async function intakeGroupFiles({ db, files, author, chatLabel, labeller, invoiceReader = null, billReader = null, amazon = null, dir = INVOICE_DIR, link = config.dashboardUrl, asked = null }) {
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
      if (group.kind === 'supplier_invoice') out.push(await invoiceFrom(db, group, { author, reader: invoiceReader, dir }));
      else if (group.kind === 'courier_bill') out.push(await billFrom(db, group, { author, reader: billReader, amazon, dir }));
      else out.push({ kind: group.kind, skipped: group.files.length });
    } catch (err) {
      out.push({ kind: group.kind, error: err.message });
    }
  }

  const shown = out.filter((o) => o.draft || o.error);
  if (shown.length) {
    const docs = out.filter((o) => o.draft);
    const others = out.filter((o) => o.skipped).reduce((n, o) => n + o.skipped, 0);
    const text = [
      `🧾 From ${author} in ${chatLabel}: ${shown.length === 1 ? (shown[0].kind === 'bill' || shown[0].kind === 'courier_bill' ? 'a courier bill' : 'an invoice') : `${shown.length} documents`}${asked ? `, asking to send ${fmtAmount(asked.currency, asked.amount)}` : ''}`,
      ...shown.flatMap((o, i) => [
        '', // a blank line between documents
        ...(o.error ? [`${i + 1}. ⚠️ Couldn’t take in this ${o.kind === 'courier_bill' ? 'courier bill' : 'invoice'}: ${o.error}. Upload it on the dashboard instead.`] : describe(o, i + 1, link)),
      ]),
      ...(others || askedLine(docs, asked, author) ? [''] : []),
      others ? `(${others} other picture(s) left alone: not an invoice or bill.)` : null,
      askedLine(docs, asked, author),
    ];
    enqueue(db, { kind: 'group_invoice', dedupeKey: `group:batch:${docs.map((o) => `${o.kind}${o.draft.id}`).join(',') || files.map((f) => f.messageId).join(',')}`, text: text.filter((x) => x !== null && x !== undefined).join('\n') });
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
    /** Adds to what's known about an open batch (e.g. the amount asked); false if none is open. */
    note(key, patch) {
      const b = open.get(key);
      if (b) Object.assign(b.meta, patch);
      return !!b;
    },
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
