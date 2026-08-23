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

const chats = loadChats();
const watched = chats.watch.map((c) => c.id);

const client = createWhatsAppClient();
let closing = false;
const bye = async (code = 0) => { if (closing) return; closing = true; await client.destroy().catch(() => {}); process.exit(code); };
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => bye(0));

client.on('ready', async () => {
  const report = await client.pupPage.evaluate(async (watchedIds) => {
    const out = { modules: {}, samples: [] };

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

    // 2. Find recent voice notes in the watched chats.
    const msgs = window.require('WAWebCollections').Msg.getModelsArray()
      .filter((m) => (m.type === 'ptt' || m.type === 'audio'))
      .filter((m) => watchedIds.includes(m.id?.remote?._serialized ?? ''))
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .slice(0, 3);

    const describe = (e) => {
      if (!e) return { note: 'falsy error' };
      const own = {};
      for (const k of Object.getOwnPropertyNames(e)) {
        if (k === 'stack') continue;
        try { own[k] = typeof e[k] === 'object' ? JSON.stringify(e[k])?.slice(0, 200) : String(e[k]); } catch { own[k] = '(unreadable)'; }
      }
      return {
        name: e.name, message: e.message, constructor: e.constructor?.name,
        ownProps: own, stackHead: String(e.stack || '').split('\n').slice(0, 3).join(' | '),
      };
    };

    for (const m of msgs) {
      const s = {
        id: m.id?._serialized?.slice(-24),
        type: m.type,
        mimetype: m.mimetype,
        size: m.size,
        ageMinutes: m.t ? Math.round((Date.now() / 1000 - m.t) / 60) : null,
        mediaStage: m.mediaData?.mediaStage ?? '(no mediaData)',
        hasDirectPath: !!m.directPath,
        hasMediaKey: !!m.mediaKey,
        hasEncFilehash: !!m.encFilehash,
      };

      // 3. Try the exact call whatsapp-web.js makes, catching in-page.
      try {
        const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
        const buf = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: m.directPath, encFilehash: m.encFilehash, filehash: m.filehash,
          mediaKey: m.mediaKey, mediaKeyTimestamp: m.mediaKeyTimestamp, type: m.type,
          signal: new AbortController().signal, downloadQpl: mockQpl,
        });
        s.result = `OK — ${buf?.byteLength ?? '?'} bytes`;
      } catch (e) {
        s.result = 'THREW';
        s.error = describe(e);
      }
      out.samples.push(s);
    }
    return out;
  }, watched);

  console.log('\n=== modules ===');
  console.log(JSON.stringify(report.modules, null, 2));
  console.log('\n=== recent voice notes in watched chats ===');
  if (!report.samples.length) console.log('  none found in the local message cache');
  for (const s of report.samples) console.log(JSON.stringify(s, null, 2));
  console.log();
  await bye(0);
});

log.info('connecting…');
client.initialize();
