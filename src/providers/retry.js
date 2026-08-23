import { log } from '../logger.js';

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'UND_ERR_SOCKET']);

/**
 * Model APIs return 503 "high demand" often enough that a single attempt loses
 * real work — and a dropped conversation here means a task you never hear about.
 * Retries transient failures only; a bad key or a malformed request fails fast.
 */
export async function withRetry(fn, { attempts = 4, baseMs = 800, label = 'request' } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts) throw err;

      // Exponential backoff with jitter, so parallel chats don't retry in lockstep.
      const wait = Math.round(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
      log.warn(`${label}: ${describe(err)} — retrying in ${wait}ms (attempt ${attempt + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function isTransient(err) {
  if (TRANSIENT_CODES.has(err?.code)) return true;
  if (TRANSIENT_STATUS.has(err?.status)) return true;

  // Gemini surfaces the status inside a JSON string on the message.
  const status = err?.error?.code ?? parseStatusFromMessage(err?.message);
  if (status && TRANSIENT_STATUS.has(status)) return true;

  return /overload|high demand|unavailable|rate.?limit|try again|timeout/i.test(String(err?.message || ''));
}

function parseStatusFromMessage(message) {
  if (!message) return null;
  const json = String(message).match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const code = JSON.parse(json[0])?.error?.code;
      if (typeof code === 'number') return code;
    } catch { /* not JSON — fall through */ }
  }
  const bare = String(message).match(/\b(4\d\d|5\d\d)\b/);
  return bare ? Number(bare[1]) : null;
}

function describe(err) {
  const status = err?.status ?? err?.error?.code ?? parseStatusFromMessage(err?.message);
  const text = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 110);
  return status ? `${status} ${text}` : text;
}
