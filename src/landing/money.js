import Decimal from 'decimal.js';

// Exact decimals throughout. Rounding happens only when a figure is shown,
// never between steps, so a chain of splits can't drift by a penny.
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Parses a number or numeric string ("1,437.67" is accepted). null/undefined/'' stay null. */
export function D(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Dec) return v;
  const s = typeof v === 'string' ? v.replace(/,/g, '').trim() : v;
  return new Dec(s);
}

export const ZERO = new Dec(0);
export const ONE = new Dec(1);

export function sum(values) {
  return values.reduce((acc, v) => (v === null || v === undefined ? acc : acc.plus(v)), ZERO);
}

/** Per-unit figures are shown to 4 places, like the sheet: 2 places loses real money at this scale. */
export function fmt4(v) {
  return v === null || v === undefined ? null : D(v).toFixed(4);
}

export function fmt2(v) {
  return v === null || v === undefined ? null : D(v).toFixed(2);
}

const commas = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 1,234.50 — for messages people read. */
export function fmtMoney(v) {
  if (v === null || v === undefined) return '—';
  const [int, dec] = D(v).toFixed(2).split('.');
  return `${commas(int)}.${dec}`;
}

/** 29,763 RMB, or 1,484.44 when there are fen. */
export function fmtRmb(v) {
  return fmtMoney(v).replace(/\.00$/, '');
}

/** Exact string for storage — SQLite REAL would reintroduce floating point. */
export function toText(v) {
  return v === null || v === undefined ? null : D(v).toString();
}

export const CURRENCY_FOR_MARKETPLACE = { UK: 'GBP', DE: 'GBP', US: 'USD' };

/** UK and DE are costed in GBP (Sellerboard wants GBP for DE too); the US in USD. */
export function costCurrency(marketplace) {
  const c = CURRENCY_FOR_MARKETPLACE[marketplace];
  if (!c) throw new Error(`Unknown marketplace "${marketplace}" — expected UK, DE or US`);
  return c;
}
