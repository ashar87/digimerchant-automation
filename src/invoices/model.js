/**
 * Reads PDF and photo invoices with Gemini. The rule that matters: a figure
 * the model can't read comes back blank, never as a plausible guess. Landing
 * cost feeds pricing and margin, so a wrong digit is worse than an empty box.
 * The arithmetic is then checked in code (checks.js), not by the model.
 */
import { D } from '../landing/money.js';
import { guessKind } from './match.js';

const SYSTEM = `You read supplier invoices for a small Amazon seller that imports from China.
Copy exactly what is printed. Rules:
- If a number is unclear, smudged, cut off, hidden or not printed, return null for it. Never estimate, infer, round or calculate a value that is not printed.
- Copy descriptions as printed, in the language printed (Chinese or English).
- Amounts are in RMB unless the invoice clearly says another currency; report the currency you see.
- One entry in "lines" per printed line item, including service fees, labour/packing charges and rate-difference lines.
- "depositReceived" is a deposit the invoice says was already paid; "deposit" is one it asks for now.`;

const num = { type: 'NUMBER', nullable: true };
const str = { type: 'STRING', nullable: true };

export const INVOICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    supplier: str,
    invoiceNumber: str,
    date: { ...str, description: 'As printed, converted to yyyy-mm-dd only if unambiguous' },
    marketplaceAsPrinted: { ...str, description: 'Destination or market printed on the invoice, e.g. USA, UK, Germany' },
    currency: str,
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { description: str, quantity: num, unitPrice: num, amount: num },
        required: ['description', 'quantity', 'unitPrice', 'amount'],
      },
    },
    total: num,
    depositPercent: num,
    deposit: num,
    depositReceived: num,
    balance: num,
    notes: { ...str, description: 'Anything printed that affects price, e.g. gold-price re-pricing terms' },
  },
  required: ['lines', 'total'],
};

/** A reader built on the configured Gemini provider. Tests pass their own `read`. */
export function geminiInvoiceReader(provider) {
  return {
    name: 'gemini',
    async read({ mime, data }) {
      const kind = mime === 'application/pdf' ? 'pdf' : 'image';
      const out = await provider.readJson({
        system: SYSTEM,
        text: 'Read this supplier invoice. Return null for anything you cannot read with certainty.',
        attachments: [{ kind, mime, data }],
        schema: INVOICE_SCHEMA,
      });
      return { ...out.data, model: out.model };
    },
  };
}

/** The model's answer in the same shape the Excel reader produces. */
export function normaliseModelReading(raw) {
  const v = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : D(x).toString());
  const unread = [];
  const lines = (raw.lines || []).map((l) => {
    const kind = guessKind(l.description);
    return { description: l.description || '', qty: v(l.quantity), unitPrice: v(l.unitPrice), rmb: v(l.amount), kind };
  });
  if (raw.total === null || raw.total === undefined) unread.push('Invoice total');
  if (raw.currency && !/rmb|cny|yuan|元|¥/i.test(raw.currency)) unread.push(`Currency (printed as ${raw.currency}, not RMB — check the amounts)`);
  return {
    method: 'model',
    model: raw.model,
    supplier: raw.supplier || null,
    invoiceNumber: raw.invoiceNumber || null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : null,
    marketplaceAsPrinted: raw.marketplaceAsPrinted || null,
    lines,
    statedTotalRmb: v(raw.total),
    depositPercent: v(raw.depositPercent),
    depositRmb: v(raw.deposit),
    depositReceivedRmb: v(raw.depositReceived),
    balanceRmb: v(raw.balance),
    notes: raw.notes || null,
    kindGuess: raw.depositReceived || raw.balance ? 'final' : 'proforma',
    unread,
  };
}
