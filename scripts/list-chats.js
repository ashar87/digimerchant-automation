/**
 * Prints every chat on your WhatsApp account with its ID, so you can pick which
 * ones go in config/chats.json. Read-only — it sends nothing and stores nothing.
 *
 * Note: this does NOT use client.getChats(). That hydrates every chat through
 * WhatsApp Web's internal serialiser inside a Promise.all, so a single chat it
 * can't serialise (a channel, a community, a broken contact) throws and you lose
 * the entire listing. We read the raw collection and skip individual bad entries.
 */
import { createWhatsAppClient } from '../src/whatsapp/client.js';
import { log } from '../src/logger.js';

const client = createWhatsAppClient();

client.on('ready', async () => {
  let chats;
  try {
    chats = await client.pupPage.evaluate(() => {
      const out = { ok: [], failed: 0 };
      const models = window.require('WAWebCollections').Chat.getModelsArray();
      for (const c of models) {
        try {
          const id = c.id?._serialized ?? String(c.id ?? '');
          if (!id) { out.failed++; continue; }
          out.ok.push({
            id,
            name: c.formattedTitle ?? c.name ?? c.contact?.name ?? c.contact?.pushname ?? null,
            timestamp: c.t ?? null,
            archived: !!c.archive,
          });
        } catch {
          out.failed++; // one unreadable chat must not cost us the rest
        }
      }
      return out;
    });
  } catch (err) {
    log.error('Could not read the chat list from WhatsApp Web:', err.message);
    log.error('This usually means WhatsApp changed its internals and whatsapp-web.js needs an update.');
    await client.destroy();
    process.exit(1);
  }

  const kind = (id) =>
    id.endsWith('@g.us') ? 'group' : id.endsWith('@newsletter') ? 'channel' : 'dm';

  const row = (c) => {
    const when = c.timestamp ? new Date(c.timestamp * 1000).toISOString().slice(0, 10) : '—';
    const name = (c.name || c.id.split('@')[0]).slice(0, 38);
    console.log(`  ${name.padEnd(38)}  last: ${when}${c.archived ? '  [archived]' : ''}  ${c.id}`);
  };

  const byRecent = (a, b) => (b.timestamp || 0) - (a.timestamp || 0);
  const groups = chats.ok.filter((c) => kind(c.id) === 'group').sort(byRecent);
  const dms = chats.ok.filter((c) => kind(c.id) === 'dm').sort(byRecent);

  console.log(`\n\x1b[1mGROUPS\x1b[0m (${groups.length})`);
  groups.forEach(row);

  console.log(`\n\x1b[1mDIRECT MESSAGES\x1b[0m (showing 40 most recent of ${dms.length})`);
  dms.slice(0, 40).forEach(row);

  console.log(`\nYour own "message yourself" chat: ${client.info.wid._serialized}`);
  if (chats.failed) console.log(`(${chats.failed} chat(s) could not be read and were skipped)`);
  console.log('\nCopy the IDs you want into config/chats.json → "watch".\n');

  await client.destroy();
  process.exit(0);
});

// Ctrl-C must shut the browser down cleanly, or the Chromium profile lock is
// left behind and the next run demands a fresh QR scan.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    log.warn(`${sig} — closing WhatsApp cleanly`);
    await client.destroy().catch(() => {});
    process.exit(0);
  });
}

log.info('connecting to WhatsApp…');
client.initialize();
