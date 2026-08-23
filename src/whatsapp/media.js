/**
 * Downloads message media without going through whatsapp-web.js's downloadMedia().
 *
 * The root cause of the "could not download ptt: r" failures is the message
 * LOOKUP, not the media. The library does:
 *
 *     Msg.get(msgId) || (await Msg.getMessagesById([msgId]))?.messages?.[0]
 *
 * On current WhatsApp Web, Msg.get() no longer resolves a serialised id string,
 * so it falls through to getMessagesById(), which throws a minified error ("r")
 * and takes the whole download with it. The same broken lookup is why
 * client.getMessageById() fails too.
 *
 * Scanning the loaded collection for the id works, and the decryption underneath
 * is fine — proven by `npm run diagnose:media`, which pulled a 126KB voice note
 * at mediaStage INIT via exactly this route.
 */
import { messageHash } from './ids.js';

export async function downloadMediaDirect(msg) {
  const hash = messageHash(msg.id);
  if (!hash) return null;

  return msg.client.pupPage.evaluate(async (msgHash) => {
    const Msg = window.require('WAWebCollections').Msg;
    // Deliberately NOT Msg.get() / getMessagesById() — see above. Matching on the
    // per-message hash, because _serialized does not exist on these models.
    const m = Msg.getModelsArray().find((x) => x.id?.id === msgHash);
    if (!m) return null;
    if (!m.directPath || !m.mediaKey) return null; // nothing to fetch with

    const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };

    const buffer = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
      directPath: m.directPath,
      encFilehash: m.encFilehash,
      filehash: m.filehash,
      mediaKey: m.mediaKey,
      mediaKeyTimestamp: m.mediaKeyTimestamp,
      type: m.type,
      signal: new AbortController().signal,
      downloadQpl: mockQpl,
    });
    if (!buffer) return null;

    let data;
    if (window.WWebJS?.arrayBufferToBase64Async) {
      data = await window.WWebJS.arrayBufferToBase64Async(buffer);
    } else {
      // Chunked so a multi-MB attachment doesn't blow the argument limit.
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      data = btoa(binary);
    }

    return { data, mimetype: m.mimetype, filename: m.filename || null, filesize: m.size || null };
  }, hash);
}
