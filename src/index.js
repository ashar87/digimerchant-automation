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

const buffer = createBuffer(async ({ chatId, chatLabel, chatContext, isGroup, unknownAssignee, notionDatabaseId, messages }) => {
  log.info(`analysing ${messages.length} message(s) from "${chatLabel}"`);

  const candidates = await extractTasks({
    chatId,
    chatLabel,
    chatContext,
    isGroup,
    messages,
    people: chats.people,
    unknownAssignee,
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
    if (m.chatId === approval.selfChatId()) {
      await approval.handleReply(msg, m);
      return;
    }

    const watched = chats.byId.get(m.chatId);
    if (!watched) return;                       // <- the allowlist. Everything else is invisible.
    if (m.timestamp < startedAt) return;        // don't replay history on first boot
    if (store.alreadySeen(m.id)) return;
    store.markSeen(m.id);

    // Text, voice notes, images, PDFs and spreadsheets all end up as one shape here.
    const buffered = await toBufferMessage(msg, m);
    if (!buffered) return;
    log.debug(`[${watched.label}] ${m.author}: ${(buffered.body || '').slice(0, 80)}`);

    buffer.add(m.chatId, {
      chatLabel: watched.label,
      chatContext: watched.context,
      isGroup: m.isGroup,
      unknownAssignee: watched.unknownAssignee || null,
      notionDatabaseId: watched.notionDatabaseId || null,
    }, buffered);
  } catch (err) {
    log.error('message handler:', err.message);
  }
});

/* ---------- lifecycle ---------- */

client.on('ready', async () => {
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
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err?.message || err));

log.info('starting WhatsApp client…');
client.initialize();
