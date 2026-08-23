/**
 * Checks that chat IDs actually exist on your account before you rely on them.
 *
 *   npm run verify                      checks every id in config/chats.json
 *   npm run verify -- <id> [<id> ...]   checks the ids you pass
 *
 * A silently wrong ID is the worst failure mode here: the bot starts, reports
 * "watching 2 chats", and then never sees a single message.
 */
import { createWhatsAppClient } from '../src/whatsapp/client.js';
import { loadChats } from '../src/config.js';
import { log } from '../src/logger.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

let wanted = args;
if (!wanted.length) {
  try {
    wanted = loadChats().watch.map((c) => c.id);
  } catch (err) {
    log.error(err.message);
    console.log('\nOr pass ids directly:  npm run verify -- 1203...@g.us 1082...@lid\n');
    process.exit(1);
  }
}

const client = createWhatsAppClient();
let closing = false;
const bye = async (code = 0) => {
  if (closing) return;
  closing = true;
  await client.destroy().catch(() => {});
  process.exit(code);
};
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => bye(0));

client.on('ready', async () => {
  const all = await client.pupPage.evaluate(() => {
    const out = [];
    for (const c of window.require('WAWebCollections').Chat.getModelsArray()) {
      try {
        const id = c.id?._serialized ?? String(c.id ?? '');
        if (id) out.push({ id, name: c.formattedTitle ?? c.name ?? null, t: c.t ?? null });
      } catch { /* skip unreadable chat */ }
    }
    return out;
  });

  const index = new Map(all.map((c) => [c.id, c]));
  let bad = 0;

  console.log();
  for (const id of wanted) {
    const hit = index.get(id);
    if (hit) {
      console.log(`  \x1b[32m✓\x1b[0m ${id}`);
      console.log(`     ${hit.name || '(untitled)'}`);
      continue;
    }
    bad++;
    console.log(`  \x1b[31m✗\x1b[0m ${id}  — no such chat on this account`);
    for (const near of nearMatches(id, all)) {
      console.log(`     did you mean?  ${near.id}   ${near.name || '(untitled)'}`);
    }
  }

  if (bad) {
    console.log(`\n\x1b[31m${bad} id(s) would never match a message.\x1b[0m Run \`npm run chats\` to re-copy them.\n`);
  } else {
    console.log(`\n\x1b[32mAll ${wanted.length} id(s) resolve.\x1b[0m\n`);
  }

  await bye(bad ? 1 : 0);
});

/** Digits get dropped when copying by hand — surface ids that differ only slightly. */
function nearMatches(id, all) {
  const digits = id.replace(/\D/g, '');
  const suffix = id.slice(id.indexOf('@'));
  return all
    .filter((c) => c.id.endsWith(suffix))
    .filter((c) => {
      const d = c.id.replace(/\D/g, '');
      return d !== digits && (d.endsWith(digits) || digits.endsWith(d) || d.includes(digits) || digits.includes(d));
    })
    .slice(0, 3);
}

log.info('connecting to WhatsApp…');
client.initialize();
