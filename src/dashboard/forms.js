import { D } from '../landing/money.js';
import { HttpError } from './errors.js';

/** Trimmed text, or undefined when blank. */
export function text(form, name) {
  const v = (form.get(name) ?? '').trim();
  return v === '' ? undefined : v;
}

/** A number as an exact string ("1,234.56" → "1234.56"), undefined when blank. Rejects anything else. */
export function number(value, label) {
  const v = String(value ?? '').trim().replace(/,/g, '');
  if (v === '') return undefined;
  try {
    const d = D(v);
    if (!d.isFinite()) throw new Error();
    return d.toString();
  } catch {
    throw new HttpError(400, `${label} isn't a number: "${value}"`);
  }
}

export function date(value, label, { required = false } = {}) {
  const v = String(value ?? '').trim();
  if (v === '') {
    if (required) throw new HttpError(400, `${label} is required`);
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${label} must be a date (yyyy-mm-dd), got "${value}"`);
  return v;
}

export function required(v, label) {
  if (v === undefined || v === null || v === '') throw new HttpError(400, `${label} is required`);
  return v;
}

/**
 * Repeated form rows: fields named `${prefix}_${field}`, one value per row in
 * document order. Rows where every `significant` field is blank are dropped.
 */
export function rows(form, prefix, fields, significant = fields) {
  const cols = Object.fromEntries(fields.map((f) => [f, form.getAll(`${prefix}_${f}`)]));
  const n = Math.max(0, ...Object.values(cols).map((c) => c.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = Object.fromEntries(fields.map((f) => [f, (cols[f][i] ?? '').trim()]));
    if (significant.some((f) => row[f] !== '')) out.push(row);
  }
  return out;
}

/** Drops undefined keys so stored records stay tidy. */
export function compact(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
}

/** "a, b , c" → ['a','b','c'] */
export function list(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** An id not yet in `taken`: base, base-2, base-3 … */
export function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
