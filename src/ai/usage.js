/**
 * A record of every Gemini call: what it was for, the tokens it used and what
 * it cost. Written by the WhatsApp listener (one row per chat cycle) and by the
 * dashboard (one per invoice read), into the landing-cost database; shown on
 * the dashboard's AI usage page.
 *
 * Cost is worked out when the call is made, from the price on that day, so the
 * history stays right when prices change.
 */
import { D } from '../landing/money.js';
import { config } from '../config.js';
import { openLandingDb } from '../landing/store.js';

// USD per 1M tokens, paid tier (standard), from ai.google.dev/gemini-api/docs/pricing,
// checked 10 Oct 2026. Thinking tokens are billed as output; audio input at the input rate.
export const PRICES = {
  'gemini-3.8-flash': [
    { from: '2000-01-01', input: '0.75', output: '3.75' },
    { from: '2027-01-01', input: '1.50', output: '7.50' },
  ],
};

export function priceOn(model, at) {
  const day = String(at).slice(0, 10);
  return (PRICES[model] || []).filter((p) => p.from <= day).at(-1) || null;
}

/** USD as an exact string, or null when the model's price isn't known. */
export function costOf({ model, at, input = 0, output = 0, thinking = 0 }) {
  const p = priceOn(model, at);
  if (!p) return null;
  return D(input).times(p.input).plus(D(output).plus(thinking).times(p.output)).div(1_000_000).toString();
}

/** Token counts from a Gemini response's usageMetadata. */
export function usageFrom(res) {
  const u = res?.usageMetadata || {};
  const audio = (u.promptTokensDetails || []).filter((d) => d.modality === 'AUDIO').reduce((n, d) => n + (d.tokenCount || 0), 0);
  return { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, thinking: u.thoughtsTokenCount ?? 0, audio };
}

export function recordUsage(db, { at = new Date().toISOString(), job, detail = null, model, input = 0, output = 0, thinking = 0, audio = 0 }) {
  const cost = costOf({ model, at, input, output, thinking });
  db.prepare('INSERT INTO ai_usage (at, job, detail, model, input_tokens, output_tokens, thinking_tokens, audio_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(at, job, detail, model, input, output, thinking, audio, cost);
}

let db;
/** Records a call made in this process. Never throws: a missed record mustn't lose the call's result. */
export function noteUsage(row) {
  try {
    recordUsage((db ??= openLandingDb(config.landingDbPath)), row);
  } catch (err) {
    console.warn(`[ai-usage] not recorded: ${err.message}`);
  }
}

export const usageRows = (db, { since = '0000', limit = 1000 } = {}) =>
  db.prepare('SELECT * FROM ai_usage WHERE at >= ? ORDER BY at DESC LIMIT ?').all(since, limit);
