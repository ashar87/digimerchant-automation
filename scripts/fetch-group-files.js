/**
 * Copies a group's recent files and messages out of WhatsApp, to see what its
 * invoices, bills and payment messages look like before writing rules for them.
 *
 *   node scripts/fetch-group-files.js "Group name" OUT_DIR [DAYS=120]
 *
 * Writes each photo / PDF / document to OUT_DIR and messages.json (time,
 * author, text or caption, the file, the message it replies to). Uses the
 * listener's WhatsApp session, so stop the listener first (systemctl), never
 * alongside it. Keep OUT_DIR out of git (private/).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createWhatsAppClient } from '../src/whatsapp/client.js';
import { log } from '../src/logger.js';
import { downloadByHash } from '../src/whatsapp/media.js';

const [name, outDir, days = '120'] = process.argv.slice(2);
if (!name || !outDir) {
  console.error('usage: node scripts/fetch-group-files.js "Group name" OUT_DIR [DAYS]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const since = Math.floor(Date.now() / 1000) - Number(days) * 86400;

const client = createWhatsAppClient();
let closing = false;
const bye = async (code = 0) => { if (closing) return; closing = true; await client.destroy().catch(() => {}); process.exit(code); };
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => bye(0));
setTimeout(() => { log.error('gave up after 15 minutes'); bye(1); }, 15 * 60_000).unref();

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };

client.on('ready', async () => {
  try {
    const found = await client.pupPage.evaluate(async (wanted, sinceTs) => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray().filter((c) => c.id?._serialized?.endsWith('@g.us') && String(c.formattedTitle ?? c.name ?? '').trim().toLowerCase() === wanted.trim().toLowerCase());
      if (chats.length !== 1) return { error: `${chats.length} groups called "${wanted}"` };
      const chat = chats[0];
      let rounds = 0;
      const oldest = () => Math.min(...chat.msgs.getModelsArray().map((m) => m.t || Infinity));
      while (rounds < 60 && oldest() > sinceTs) {
        const more = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
        rounds++;
        if (!more || !more.length) break;
      }
      const msgs = chat.msgs.getModelsArray().filter((m) => (m.t || 0) >= sinceTs).sort((a, b) => a.t - b.t);
      return {
        rounds,
        messages: msgs.map((m) => ({
          hash: m.id?.id,
          t: m.t,
          author: m.id?.fromMe ? 'Ashar' : m.senderObj?.name || m.senderObj?.pushname || m.notifyName || 'someone',
          type: m.type,
          text: m.type === 'chat' ? m.body : m.caption || null,
          mime: m.mimetype || null,
          filename: m.filename || null,
          quoted: m.quotedStanzaID || null,
        })),
      };
    }, name, since);
    if (found.error) throw new Error(found.error);
    log.info(`${found.messages.length} message(s) since ${new Date(since * 1000).toISOString().slice(0, 10)} (${found.rounds} load(s))`);

    let saved = 0;
    for (const m of found.messages) {
      if (!['image', 'document'].includes(m.type)) continue;
      const r = await downloadByHash(client.pupPage, m.hash).catch((e) => ({ reason: 'page-error', detail: String(e?.message || e) }));
      if (!r?.data) {
        m.file = null;
        m.downloadFailed = `${r?.reason}: ${r?.detail}`;
        continue;
      }
      const stamp = new Date(m.t * 1000).toISOString().replace(/[:T]/g, '-').slice(0, 19);
      m.file = `${stamp}_${m.hash.slice(-6)}.${EXT[String(r.mimetype).split(';')[0]] || 'bin'}`;
      fs.writeFileSync(path.join(outDir, m.file), Buffer.from(r.data, 'base64'), { mode: 0o600 });
      saved++;
    }
    fs.writeFileSync(path.join(outDir, 'messages.json'), JSON.stringify(found.messages, null, 1), { mode: 0o600 });
    log.ok(`saved ${saved} file(s) and messages.json to ${outDir}`);
    await bye(0);
  } catch (err) {
    log.error(err.message);
    await bye(1);
  }
});

log.info('connecting…');
client.initialize();
