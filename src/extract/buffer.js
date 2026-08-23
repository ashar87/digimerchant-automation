import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Messages are batched per chat rather than classified one at a time. A single
 * message is usually meaningless ("ok do that one first") — the task only exists
 * in the surrounding exchange. A chat is flushed to Claude when it has been quiet
 * for FLUSH_IDLE_SECONDS, or when FLUSH_MAX_MESSAGES have piled up.
 */
export function createBuffer(onFlush) {
  const chats = new Map(); // chatId -> { messages, timer, meta }

  function add(chatId, meta, message) {
    let entry = chats.get(chatId);
    if (!entry) {
      entry = { messages: [], timer: null, meta };
      chats.set(chatId, entry);
    }
    entry.meta = meta;
    entry.messages.push(message);

    clearTimeout(entry.timer);

    if (entry.messages.length >= config.flushMaxMessages) {
      log.debug(`buffer: "${meta.chatLabel}" hit max messages, flushing now`);
      return flush(chatId);
    }
    entry.timer = setTimeout(() => flush(chatId), config.flushIdleSeconds * 1000);
    log.debug(`buffer: "${meta.chatLabel}" now holds ${entry.messages.length} msg(s)`);
  }

  async function flush(chatId) {
    const entry = chats.get(chatId);
    if (!entry || entry.messages.length === 0) return;
    clearTimeout(entry.timer);
    chats.delete(chatId);

    try {
      await onFlush({ chatId, ...entry.meta, messages: entry.messages });
    } catch (err) {
      log.error(`flush failed for ${entry.meta.chatLabel}:`, err.message);
    }
  }

  async function flushAll() {
    await Promise.all([...chats.keys()].map(flush));
  }

  return { add, flush, flushAll, size: () => chats.size };
}
