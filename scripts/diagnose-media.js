/**
 * Works out why a voice note won't download.
 *
 *   npm run diagnose:media
 *
 * Errors thrown inside WhatsApp Web lose almost everything crossing the Puppeteer
 * boundary — that's why the log said "r". This catches them INSIDE the page and
 * serialises them there, so we see what actually failed.
 */
import { createWhatsAppClient } from '../src/whatsapp/client.js';
import { loadChats } from '../src/config.js';
import { log } from '../src/logger.js';
import { downloadByHash } from '../src/whatsapp/media.js';

const chats = loadChats();
const watched = chats.watch.map((c) => c.id);

const client = createWhatsAppClient();
let closing = false;
const bye = async (code = 0) => { if (closing) return; closing = true; await client.destroy().catch(() => {}); process.exit(code); };
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => bye(0));

client.on('ready', async () => {
  const report = await client.pupPage.evaluate(async (watchedIds) => {
    const out = { modules: {}, samples: [], loaded: 0 };

    // 1. Are the modules the library depends on still there?
    for (const name of ['WAWebDownloadManager', 'WAWebCollections']) {
      try {
        const mod = window.require(name);
        out.modules[name] = mod ? Object.keys(mod).slice(0, 12) : 'require returned falsy';
      } catch (e) {
        out.modules[name] = `require threw: ${e?.message || e}`;
      }
    }
    try {
      const dm = window.require('WAWebDownloadManager')?.downloadManager;
      out.modules.downloadManagerKeys = dm ? Object.keys(dm).slice(0, 20) : 'no downloadManager';
      out.modules.hasDownloadAndMaybeDecrypt = typeof dm?.downloadAndMaybeDecrypt;
    } catch (e) {
      out.modules.downloadManagerKeys = `threw: ${e?.message || e}`;
    }

    // 2. Find recent voice notes in the watched chats. Ids no longer carry
    // _serialized, so the chat is matched on user@server.
    const chatOf = (m) => {
      const r = m.id?.remote;
      if (!r) return '';
      if (typeof r === 'string') return r;
      return r._serialized || (r.user && r.server ? `${r.user}@${r.server}` : String(r));
    };
    // A fresh session only has the last few messages per chat in memory, so load
    // earlier ones (the library's own fetchMessages method) until voice notes turn up.
    out.history = {};
    for (const id of watchedIds) {
      try {
        const chat = await window.WWebJS.getChat(id, { getAsModel: false });
        let rounds = 0;
        while (rounds < 8 && !chat.msgs.getModelsArray().some((m) => m.type === 'ptt' || m.type === 'audio')) {
          const more = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
          rounds++;
          if (!more || !more.length) break;
        }
        out.history[id.slice(-12)] = `${chat.msgs.getModelsArray().length} messages after ${rounds} load(s)`;
      } catch (e) {
        out.history[id.slice(-12)] = `could not load: ${e?.message || e}`;
      }
    }
    const inCollection = new Set(window.require('WAWebCollections').Msg.getModelsArray().map((m) => m.id?.id));
    const all = window.require('WAWebCollections').Chat.getModelsArray().flatMap((c) => c.msgs?.getModelsArray?.() || []);
    out.loaded = all.length;
    out.samples = all
      .filter((m) => m.type === 'ptt' || m.type === 'audio')
      .filter((m) => watchedIds.includes(chatOf(m)))
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .slice(0, 5)
      .map((m) => ({
        hash: m.id?.id,
        chat: chatOf(m).slice(-12),
        ageMinutes: m.t ? Math.round((Date.now() / 1000 - m.t) / 60) : null,
        mediaStage: m.mediaData?.mediaStage ?? '(no mediaData)',
        hasDirectPath: !!m.directPath,
        hasMediaKey: !!m.mediaKey,
        inMsgCollection: inCollection.has(m.id?.id),
      }));
    return out;
  }, watched);

  // 3. Try each through exactly the path the service uses.
  for (const s of report.samples) {
    const r = await downloadByHash(client.pupPage, s.hash).catch((e) => ({ reason: 'page-error', detail: String(e?.message || e) }));
    s.result = r?.data ? `OK — ${Buffer.byteLength(r.data, 'base64')} bytes, ${r.mimetype}` : `FAILED — ${r?.reason}: ${r?.detail}`;
  }

  console.log('\n=== modules ===');
  console.log(JSON.stringify(report.modules, null, 2));
  console.log('\n=== history loaded ===');
  console.log(JSON.stringify(report.history, null, 2));
  console.log(`\n=== recent voice notes in watched chats (${report.loaded} messages loaded) ===`);
  if (!report.samples.length) console.log('  none found in the local message cache');
  for (const s of report.samples) console.log(JSON.stringify(s, null, 2));
  console.log();
  await bye(0);
});

log.info('connecting…');
client.initialize();
