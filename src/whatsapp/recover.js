/**
 * Voice notes that couldn't be read when they arrived are retried later: after
 * the listener reconnects (it restarts itself when WhatsApp Web's downloads are
 * stuck) and every half hour. A recovered note is transcribed and checked for
 * tasks like any other message; either way Ashar is told how it went.
 *
 * Gives up after 4 tries or 2 days, by when WhatsApp has usually dropped the audio.
 */
import { downloadByHash } from './media.js';

export const MAX_TRIES = 4;
export const MAX_AGE_MS = 2 * 86400_000;
const AROUND_S = 10 * 60; // a search row looks this far either side of its time

/** Loads the chat's history back to `ts` and returns its voice notes near it: [{ hash, t, author }]. */
function findVoiceNotes(page, chatId, ts) {
  return page.evaluate(
    async (id, from, to) => {
      const chat = await window.WWebJS.getChat(id, { getAsModel: false });
      for (let rounds = 0; rounds < 15; rounds++) {
        const msgs = chat.msgs.getModelsArray();
        if (msgs.length && Math.min(...msgs.map((m) => m.t || Infinity)) <= from) break;
        const more = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
        if (!more || !more.length) break;
      }
      return chat.msgs
        .getModelsArray()
        .filter((m) => (m.type === 'ptt' || m.type === 'audio') && m.t >= from && m.t <= to)
        .map((m) => ({ hash: m.id?.id, t: m.t }));
    },
    chatId,
    ts - AROUND_S,
    ts + AROUND_S
  );
}

/**
 * One pass over the pending rows. `transcribe(attachment, id)` and
 * `onRecovered(row, text)` / `onGaveUp(row)` are the listener's.
 */
export async function recoverMissed({ page, store, transcribe, onRecovered, onGaveUp, log, now = Date.now(), again = true }) {
  let recovered = 0;
  let searched = false;
  for (let row of store.pendingMissed()) {
    try {
      if (!row.hash) {
        const found = await findVoiceNotes(page, row.chat_id, row.ts);
        store.expandMissed(row, found.map((f) => f.hash).filter(Boolean));
        log.info(`looking again for voice notes around ${new Date(row.ts * 1000).toISOString()}: found ${found.length}`);
        searched = true;
        continue; // the rows it found are tried straight after this pass
      }
      await findVoiceNotes(page, row.chat_id, row.ts); // make sure the message is loaded
      const r = await downloadByHash(page, row.hash);
      if (r?.data) {
        const text = await transcribe({ kind: 'audio', mime: String(r.mimetype || 'audio/ogg').split(';')[0], data: r.data, bytes: Buffer.byteLength(r.data, 'base64') }, row.hash);
        if (text) {
          store.settleMissed(row.id, 'recovered');
          recovered++;
          log.ok(`recovered a voice note from ${row.author || 'someone'}`);
          await onRecovered(row, text);
          continue;
        }
        store.triedMissed(row.id, 'transcription failed');
      } else {
        store.triedMissed(row.id, r?.reason || 'unknown');
      }
    } catch (err) {
      store.triedMissed(row.id, String(err?.message || err).slice(0, 120));
    }
    row = store.pendingMissed().find((x) => x.id === row.id);
    if (row && (row.attempts >= MAX_TRIES || now - row.ts * 1000 > MAX_AGE_MS)) {
      store.settleMissed(row.id, 'given_up');
      await onGaveUp(row);
    }
  }
  if (searched && again) recovered += await recoverMissed({ page, store, transcribe, onRecovered, onGaveUp, log, now, again: false });
  return recovered;
}
