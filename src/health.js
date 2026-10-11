/**
 * The WhatsApp listener's health, kept where the dashboard can see it (the
 * landing-cost database), so the Inbox can say when it's offline: WhatsApp
 * itself can't carry that message when WhatsApp is what broke.
 *
 * The listener writes a heartbeat every minute while connected, what it found
 * when a start got stuck, and a daily check for a newer whatsapp-web.js.
 * Written straight to settings, without the audit log, which a heartbeat would flood.
 */
const KEY = 'listener_health';
export const OFFLINE_AFTER_MS = 10 * 60_000;
export const PIN_WARN_DAYS = 14;

export function readHealth(db) {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY)?.value;
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeHealth(db, patch) {
  const next = { ...(readHealth(db) || {}), ...patch };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(next));
  return next;
}

/** True when version a is newer than b ("1.35.0" > "1.34.7"). */
export function newer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/**
 * Inbox lines about the listener. `pinned` / `pinExpires` come from the
 * dashboard's own config (the same .env the listener reads).
 */
export function healthItems(health, { now = Date.now(), pinned = null, pinExpires = null, when = (iso) => iso } = {}) {
  const items = [];
  if (health?.beatAt && now - Date.parse(health.beatAt) > OFFLINE_AFTER_MS) {
    const stuck = health.stuck && Date.parse(health.stuck.at) > Date.parse(health.beatAt) ? health.stuck : null;
    items.push({
      tone: 'error',
      title: `The WhatsApp listener has been offline since ${when(health.beatAt)}: no tasks are being picked up and no alerts sent.${
        stuck ? ` WhatsApp Web ${stuck.version || '(unknown version)'} loads but the library can't connect to it${stuck.store === false ? ' (store missing)' : ''}: it needs a library update or a re-pinned version.` : ''
      }`,
      href: '/settings',
      count: true,
    });
  }
  if (pinned && pinExpires) {
    const days = Math.ceil((Date.parse(`${pinExpires}T00:00:00Z`) - now) / 864e5);
    if (days <= PIN_WARN_DAYS) {
      items.push({ tone: days <= 0 ? 'error' : 'warning', title: `WhatsApp Web is pinned to an older version (${pinned}), which ${days <= 0 ? 'has passed' : `reaches in ${days} day${days === 1 ? '' : 's'}`} its expiry date (${pinExpires}). Time to upgrade the library or re-pin.`, href: '/settings', count: true });
    }
  }
  const lib = health?.lib;
  if (lib?.latest && lib?.installed && newer(lib.latest, lib.installed)) {
    items.push({ tone: pinned ? 'warning' : 'info', title: `whatsapp-web.js ${lib.latest} is out (running ${lib.installed}).${pinned ? ' Upgrade it and remove the WhatsApp Web pin.' : ' Worth upgrading.'}`, href: '/settings', count: !!pinned });
  }
  return items;
}
