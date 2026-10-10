// AI usage: every Gemini call (a WhatsApp chat cycle, an invoice read), with tokens and cost.
import { html } from '../html.js';
import { D } from '../../landing/money.js';
import { usageRows, priceOn } from '../../ai/usage.js';
import { config } from '../../config.js';

const JOBS = { tasks: 'WhatsApp cycle', invoice: 'Invoice read', transcribe: 'Voice note', document: 'Document read' };
const n = (v) => Number(v || 0).toLocaleString('en-GB');
const usd = (v) => {
  if (v === null || v === undefined) return '—';
  const d = D(v);
  return d.isZero() ? '$0' : d.lt('0.01') ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
};
const localDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date(iso));
const when = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function totals(rows) {
  const t = { calls: rows.length, input: 0, output: 0, cost: D(0), unpriced: 0 };
  for (const r of rows) {
    t.input += r.input_tokens;
    t.output += r.output_tokens + r.thinking_tokens;
    if (r.cost_usd === null) t.unpriced++;
    else t.cost = t.cost.plus(r.cost_usd);
  }
  return t;
}

export function usagePage(ctx) {
  const rows = usageRows(ctx.db, { since: new Date(Date.now() - 400 * 864e5).toISOString() });
  const today = localDay(new Date().toISOString());
  const month = today.slice(0, 7);
  const periods = [
    ['Today', rows.filter((r) => localDay(r.at) === today)],
    ['This month', rows.filter((r) => localDay(r.at).startsWith(month))],
    ['Last 12 months', rows],
  ].map(([label, list]) => ({ label, ...totals(list) }));

  const byDay = new Map();
  for (const r of rows) {
    const d = localDay(r.at);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  const days = [...byDay.entries()].slice(0, 31).map(([day, list]) => ({ day, ...totals(list) }));
  const price = priceOn(config.geminiModel, new Date().toISOString());

  const body = html`
<h1>AI usage</h1>
<p class="sub">Every Gemini call: one per WhatsApp chat cycle (the messages and voice notes checked together once a chat goes quiet), and one per invoice read. Costs in US dollars, at the price on the day.</p>
<div class="stats">${periods.map(
    (p) => html`<div class="card"><div class="muted small">${p.label}</div><div class="big">${usd(p.cost.toString())}</div>
<div class="small muted">${n(p.calls)} call${p.calls === 1 ? '' : 's'}<br>${n(p.input)} in / ${n(p.output)} out${p.unpriced ? html`<br>${p.unpriced} unpriced` : ''}</div></div>`
  )}</div>
<p class="muted small">Model ${config.geminiModel}${price ? html`: $${price.input} per million tokens in, $${price.output} out (thinking counts as out)` : ': price not known, so its calls show no cost'}.</p>

<h2>By day</h2>
${days.length
  ? html`<div class="card scroll"><table><thead><tr><th>Day</th><th class="n">Calls</th><th class="n">Tokens in</th><th class="n">Tokens out</th><th class="n key">Cost</th></tr></thead><tbody>
${days.map((d) => html`<tr><td>${d.day}</td><td class="n">${n(d.calls)}</td><td class="n">${n(d.input)}</td><td class="n">${n(d.output)}</td><td class="n">${usd(d.cost.toString())}</td></tr>`)}
</tbody></table></div>`
  : html`<p class="muted">No calls recorded yet.</p>`}

<h2>Recent calls</h2>
${rows.length
  ? html`<div class="card scroll"><table><thead><tr><th>When</th><th>Job</th><th>Detail</th><th class="n">In</th><th class="n">Out</th><th class="n">Thinking</th><th class="n key">Cost</th></tr></thead><tbody>
${rows.slice(0, 100).map((r) => html`<tr><td>${when(r.at)}</td><td>${JOBS[r.job] || r.job}</td><td class="small">${r.detail || ''}${r.audio_tokens ? html` <span class="muted">(${n(r.audio_tokens)} audio)</span>` : ''}</td><td class="n">${n(r.input_tokens)}</td><td class="n">${n(r.output_tokens)}</td><td class="n">${n(r.thinking_tokens)}</td><td class="n">${usd(r.cost_usd)}</td></tr>`)}
</tbody></table></div>`
  : ''}`;
  return { title: 'AI usage', body };
}
