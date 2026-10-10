/**
 * Downloads message media without going through whatsapp-web.js's downloadMedia().
 *
 * The library looks the message up with Msg.get(id) || Msg.getMessagesById([id]).
 * On current WhatsApp Web, Msg.get() no longer resolves a serialised id and
 * getMessagesById() throws a minified error ("r"), so the library's download
 * can never succeed. We find the message by scanning the loaded collection for
 * its per-message hash instead, then do what the library would have done:
 * resolve the media if WhatsApp hasn't yet, and decrypt it.
 *
 * The decrypt call must be given the message's mimetype: since October 2026
 * WhatsApp Web checks the decrypted file against it and rejects every voice note
 * otherwise. The library (1.34.7) doesn't pass it, which is a second reason its
 * download fails.
 *
 * Never throws. On failure it says why (`reason`, `detail`), worked out inside
 * the page: errors thrown there lose everything crossing the Puppeteer boundary,
 * which is how a week of voice-note failures came to be logged as just "r".
 */
import { messageHash } from './ids.js';

export async function downloadMediaDirect(msg) {
  const hash = messageHash(msg.id);
  if (!hash) return { reason: 'no-id', detail: 'the message has no id hash' };
  return downloadByHash(msg.client.pupPage, hash).catch((err) => ({ reason: 'page-error', detail: String(err?.message || err).slice(0, 200) }));
}

/** The in-page download, by message hash. Shared with scripts/diagnose-media.js. */
export function downloadByHash(page, hash) {
  return page.evaluate(async (msgHash) => {
    const explain = (e) => {
      if (!e) return 'falsy error';
      const props = [];
      for (const k of Object.getOwnPropertyNames(e)) {
        if (k === 'stack' || k === 'message') continue;
        try {
          props.push(`${k}=${typeof e[k] === 'object' ? JSON.stringify(e[k]).slice(0, 80) : String(e[k]).slice(0, 80)}`);
        } catch {}
      }
      const stack = String(e.stack || '').split('\n').slice(1, 3).map((s) => s.trim()).join(' | ');
      return [e.constructor?.name, e.name, e.message, props.join(', '), stack].filter(Boolean).join(' · ').slice(0, 400);
    };

    try {
      const Msg = window.require('WAWebCollections').Msg;
      const models = Msg.getModelsArray();
      const m = models.find((x) => x.id?.id === msgHash);
      if (!m) return { reason: 'not-loaded', detail: `not among the ${models.length} messages loaded in WhatsApp Web` };

      const stage = () => m.mediaData?.mediaStage || '(no mediaData)';
      if (stage() === 'REUPLOADING') return { reason: 'reuploading', detail: 'expired on the server; the phone is re-uploading it' };

      // What the library does before decrypting: ask WhatsApp to resolve the media.
      if (m.mediaData && stage() !== 'RESOLVED') {
        try {
          await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
        } catch (e) {
          return { reason: 'resolve-failed', detail: `stage ${stage()}: ${explain(e)}` };
        }
      }
      if (stage().includes('ERROR') || stage() === 'FETCHING') return { reason: 'not-ready', detail: `stage ${stage()}` };
      if (!m.directPath || !m.mediaKey) return { reason: 'no-media-path', detail: `stage ${stage()}, directPath ${!!m.directPath}, mediaKey ${!!m.mediaKey}` };

      let buffer;
      try {
        const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
        buffer = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: m.directPath,
          encFilehash: m.encFilehash,
          filehash: m.filehash,
          mediaKey: m.mediaKey,
          mediaKeyTimestamp: m.mediaKeyTimestamp,
          type: m.type,
          // WhatsApp Web now checks the decrypted file against this; without it the
          // file counts as application/octet-stream and every voice note is rejected
          // ("InvalidMediaFileType: Unexpected mimetype ... for media type ptt").
          mimetype: m.mimetype,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });
      } catch (e) {
        return { reason: 'decrypt-failed', detail: `stage ${stage()}: ${explain(e)}` };
      }
      if (!buffer) return { reason: 'empty', detail: `stage ${stage()}: download returned nothing` };

      let data;
      if (window.WWebJS?.arrayBufferToBase64Async) {
        data = await window.WWebJS.arrayBufferToBase64Async(buffer);
      } else {
        // Chunked so a multi-MB attachment doesn't blow the argument limit.
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        data = btoa(binary);
      }
      return { data, mimetype: m.mimetype, filename: m.filename || null, filesize: m.size || null };
    } catch (e) {
      return { reason: 'page-error', detail: explain(e) };
    }
  }, hash);
}
