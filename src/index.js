import { config, loadChats, assertEnv, assertProviderEnv } from './config.js';
import { log } from './logger.js';
import { createWhatsAppClient, describeMessage } from './whatsapp/client.js';
import { createApprovalFlow } from './whatsapp/approval.js';
import { createBuffer } from './extract/buffer.js';
import { extractTasks } from './extract/classifier.js';
import { toBufferMessage } from './media/ingest.js';
import { getProvider } from './providers/index.js';
import * as store from './store/db.js';

let chats;
try {
  assertProviderEnv();
  assertEnv(['notionApiKey', 'notionDatabaseId']);
  chats = loadChats();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

const client = createWhatsAppClient();
const approval = createApprovalFlow(client);
const startedAt = Math.floor(Date.now() / 1000) - config.catchUpMinutes * 60;

/* ---------- buffered conversation -> Claude -> approval cards ---------- */

const buffer = createBuffer(async ({ chatId, chatLabel, chatContext, isGroup, unknownAssignee, assignAllTo, notionDatabaseId, messages }) => {
  log.info(`analysing ${messages.length} message(s) from "${chatLabel}"`);

  const candidates = await extractTasks({
    chatId,
    chatLabel,
    chatContext,
    isGroup,
    messages,
    people: chats.people,
    unknownAssignee,
    assignAllTo,
  });

  if (candidates.length === 0) {
    log.info(`no tasks in "${chatLabel}"`);
    return;
  }

  for (const candidate of candidates) {
    const fp = store.fingerprintOf(chatId, candidate.title);
    if (store.isDuplicate(fp)) {
      log.info(`skipping duplicate: ${candidate.title}`);
      continue;
    }
    store.rememberFingerprint(fp, null);
    const saved = store.saveCandidate({ ...candidate, notionDatabaseId });
    await approval.sendCard(saved);
  }
});

/* ---------- message intake ---------- */

client.on('message_create', async (msg) => {
  try {
    const m = await describeMessage(msg);

    // Your own self-chat is the control channel, never a source of tasks.
    if (approval.isSelfChat(m.chatId)) {
      await approval.handleReply(msg, m);
      return;
    }

    const watched = chats.byId.get(m.chatId);
    if (!watched) {
      // A command you typed that didn't land in the recognised self-chat would
      // otherwise vanish without trace. Log where it went (chat id only, no content).
      if (m.fromMe && /^(y|n|e|yes|no|pending|help)\b/i.test(m.body || '')) {
        log.warn(`a command-like message from you arrived in ${m.chatId}, which isn't recognised as your self-chat (${[...approval.selfIds()].join(' / ')}); ignored`);
      }
      return;                                   // <- the allowlist. Everything else is invisible.
    }
    if (m.timestamp < startedAt) return;        // don't replay history on first boot
    if (store.alreadySeen(m.id)) return;
    store.markSeen(m.id);

    // Text, voice notes, images, PDFs and spreadsheets all end up as one shape here.
    const buffered = await toBufferMessage(msg, m);
    if (!buffered) return;
    if (buffered.missed) {
      await reportGap(watched.label, buffered);
      return;
    }
    log.debug(`[${watched.label}] ${m.author}: ${(buffered.body || '').slice(0, 80)}`);

    buffer.add(m.chatId, {
      chatLabel: watched.label,
      chatContext: watched.context,
      isGroup: m.isGroup,
      unknownAssignee: watched.unknownAssignee || null,
      assignAllTo: watched.assignAllTo || null,
      notionDatabaseId: watched.notionDatabaseId || null,
    }, buffered);
  } catch (err) {
    log.error('message handler:', err.message);
  }
});

/* ---------- gaps ---------- */

/**
 * Something was said that we could not read. Silence here would defeat the point
 * of the system, so tell Ashar — but throttled, because a phone that is offline
 * will fail every voice note in a row and he does not need twenty messages.
 */
const gapWindowMs = 15 * 60 * 1000;
const gaps = new Map(); // chatLabel -> { count, first, timer }

async function reportGap(chatLabel, { missed, author }) {
  log.warn(`MISSED a ${missed} from ${author} in "${chatLabel}"`);

  const entry = gaps.get(chatLabel) || { count: 0, first: Date.now(), timer: null, author, missed };
  entry.count++;
  entry.author = author;
  entry.missed = missed;
  gaps.set(chatLabel, entry);

  if (entry.timer) return; // an alert is already queued for this chat
  entry.timer = setTimeout(async () => {
    gaps.delete(chatLabel);
    const since = new Date(entry.first).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const plural = entry.count === 1 ? `a ${entry.missed}` : `${entry.count} ${entry.missed}s`;
    await approval.send(
      `⚠️ Couldn't read ${plural} from ${entry.author} in *${chatLabel}* since ${since}.\n\n` +
        `Nothing from ${entry.count === 1 ? 'it' : 'them'} has been checked for tasks — worth a look yourself.\n` +
        `Usual cause: your phone was offline, so it never re-uploaded the audio.`
    ).catch((err) => log.error('could not send gap alert:', err.message));
  }, gapWindowMs);
  entry.timer.unref?.();
}

/* ---------- lifecycle ---------- */

/**
 * A failed startup used to leave the process alive but useless: Chromium up,
 * WhatsApp never ready, no messages ever processed, and systemd none the wiser
 * because nothing exited. Observed in the wild after a fast restart, where
 * Chromium's previous context was torn down mid-initialisation.
 *
 * So: if we are not ready within the timeout, exit non-zero and let the service
 * manager restart us. Dying loudly beats idling silently.
 */
let isReady = false;
const readyTimer = setTimeout(() => {
  if (isReady) return;
  log.error(`WhatsApp did not become ready within ${config.readyTimeoutSeconds}s — exiting so the service restarts`);
  process.exit(1);
}, config.readyTimeoutSeconds * 1000);

client.on('ready', async () => {
  isReady = true;
  clearTimeout(readyTimer);
  await approval.init();
  log.ok(`connected as ${client.info.pushname} (${client.info.wid.user})`);
  log.info(`watching ${chats.watch.length} chat(s):`);
  for (const c of chats.watch) log.info(`   • ${c.label}`);
  const p = getProvider();
  const model = p.name === 'gemini' ? config.geminiModel : config.anthropicModel;
  const media = [
    config.enableImages && 'images',
    config.enableVoiceNotes && `voice notes (${config.transcriber})`,
    config.enableDocuments && 'documents',
  ].filter(Boolean);
  log.info(`model: ${p.name} / ${model} · media: ${media.join(', ') || 'text only'}`);
  log.info(`flushing after ${config.flushIdleSeconds}s idle · min confidence ${config.minConfidence}${config.dryRun ? ' · DRY RUN' : ''}`);

  const pending = store.listPending();
  if (pending.length) {
    log.info(`${pending.length} task(s) still awaiting your decision`);
    await approval.sendPendingList();
  }
});

setInterval(() => {
  const n = store.expireStale(config.expirePendingDays * 86400_000);
  if (n) log.info(`expired ${n} stale pending task(s)`);
}, 3600_000).unref();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`${signal} — flushing buffered conversations before exit`);
  await buffer.flushAll();
  await client.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection:', err?.message || err);
  // Before ready, a rejection means initialisation is broken — there is nothing
  // to salvage, so exit and let the service manager retry. After ready, a
  // transient error must not take down a working listener.
  if (!isReady && !shuttingDown) {
    log.error('that happened during startup — exiting so the service restarts');
    process.exit(1);
  }
});

log.info('starting WhatsApp client…');
client.initialize();
