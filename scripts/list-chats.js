/**
 * Prints every chat on your WhatsApp account with its ID, so you can pick which
 * ones go in config/chats.json. Read-only — it sends nothing and stores nothing.
 */
import { createWhatsAppClient } from '../src/whatsapp/client.js';
import { log } from '../src/logger.js';

const client = createWhatsAppClient();

client.on('ready', async () => {
  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);
  const dms = chats.filter((c) => !c.isGroup);

  const row = (c) => {
    const when = c.timestamp ? new Date(c.timestamp * 1000).toISOString().slice(0, 10) : '—';
    console.log(`  ${String(c.name || c.id.user).padEnd(38).slice(0, 38)}  last: ${when}  ${c.id._serialized}`);
  };

  console.log('\n\x1b[1mGROUPS\x1b[0m');
  groups.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).forEach(row);

  console.log('\n\x1b[1mDIRECT MESSAGES\x1b[0m (most recent 40)');
  dms.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 40).forEach(row);

  console.log(`\nYour own "message yourself" chat: ${client.info.wid._serialized}`);
  console.log('\nCopy the IDs you want into config/chats.json → "watch".\n');

  await client.destroy();
  process.exit(0);
});

log.info('connecting to WhatsApp…');
client.initialize();
