/**
 * Stable message identity.
 *
 * whatsapp-web.js expects every message id to carry `_serialized`. Current
 * WhatsApp Web no longer provides it — a message key is `{ fromMe, remote, id,
 * participant }` with no serialised form — so `msg.id._serialized` is undefined
 * everywhere. That broke four things silently at once:
 *
 *   - duplicate suppression (every message looked new)
 *   - the voice-note transcript cache (re-transcribed, re-charged, every time)
 *   - approving a task by replying to its card (the card's id never matched)
 *   - media downloads (the message lookup was handed undefined)
 *
 * So we build the identity ourselves out of the parts that do exist. `id.id` is
 * the unique per-message hash and is present on both the in-page model and the
 * serialised copy, which is what makes this stable across the boundary.
 */
export function messageKey(idLike) {
  if (!idLike) return null;
  if (typeof idLike === 'string') return idLike || null;
  if (idLike._serialized) return idLike._serialized; // future-proof: use it if it returns

  const hash = idLike.id;
  if (!hash) return null;
  return `${idLike.fromMe ? 'true' : 'false'}_${widString(idLike.remote)}_${hash}`;
}

/** The unique per-message hash, used to find a message inside the page. */
export function messageHash(idLike) {
  if (!idLike) return null;
  if (typeof idLike === 'string') {
    const parts = idLike.split('_');
    return parts.length >= 3 ? parts[2] : null;
  }
  return idLike.id || null;
}

/** Wid objects still carry _serialized; strings pass through. */
export function widString(wid) {
  if (!wid) return '';
  if (typeof wid === 'string') return wid;
  if (wid._serialized) return wid._serialized;
  if (wid.user && wid.server) return `${wid.user}@${wid.server}`;
  return String(wid);
}
