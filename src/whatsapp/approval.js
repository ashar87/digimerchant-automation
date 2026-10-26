import { config } from '../config.js';
import { log } from '../logger.js';
import * as store from '../store/db.js';
import { addWhatsAppTask } from '../tasks/board.js';
import { findByWaMessage, getCard } from '../notify/outbox.js';
import { deliverOutbox, parseCardAnswer } from '../notify/deliver.js';
import { applyCardReply } from '../amazon/links.js';
import { createSpApi, spApiConfigured } from '../amazon/spapi.js';
import { messageKey, widString } from './ids.js';
import { shortDate } from '../util/time.js';

/** IDs of messages this bot sent. They come back through message_create as fromMe. */
const sentByBot = new Set();

// Amazon, for writing the PO into a shipment's name when a link is answered here.
let amazon;
const amazonClient = () => (spApiConfigured(config.spapi) ? (amazon ??= createSpApi(config.spapi)) : null);

export function createApprovalFlow(client) {
  /**
   * The "Message yourself" chat, where every approval card lands. WhatsApp now
   * addresses it by a LID (…@lid) as well as by phone number (…@c.us), and
   * incoming messages carry the LID, so both count as the self-chat. Sending
   * still goes to the phone-number address, which WhatsApp resolves.
   */
  const selfIds = new Set();
  const selfChatId = () => widString(client.info.wid);
  const isSelfChat = (chatId) => chatId === selfChatId() || selfIds.has(chatId);

  /** Call once on ready: learns the self-chat's LID. */
  async function init() {
    selfIds.add(selfChatId());
    try {
      const lid = await client.pupPage.evaluate(() => {
        const u = window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser?.();
        return u ? u._serialized || `${u.user}@${u.server}` : null;
      });
      if (lid) selfIds.add(lid);
    } catch (err) {
      log.warn(`could not look up the self-chat's LID: ${err.message}`);
    }
    log.info(`self-chat: ${[...selfIds].join(' / ')}`);
  }

  /**
   * client.sendMessage() now resolves to undefined even though the message is
   * sent, so the sent message's id comes from its echo (message_create) instead.
   * That id is what lets a quoted reply be matched to its card.
   */
  const awaitingEcho = new Map(); // text -> resolve(id)
  function noteEcho(described) {
    const resolve = awaitingEcho.get(described.body);
    if (!resolve) return false;
    awaitingEcho.delete(described.body);
    resolve(described.id);
    return true;
  }

  async function send(text) {
    if (config.dryRun) {
      log.warn('DRY_RUN: would send to self chat:\n' + text);
      return null;
    }
    const body = text.trim();
    const echo = new Promise((resolve) => {
      awaitingEcho.set(body, resolve);
      setTimeout(() => {
        if (awaitingEcho.get(body) === resolve) {
          awaitingEcho.delete(body);
          resolve(null);
        }
      }, 20_000);
    });
    const msg = await client.sendMessage(selfChatId(), text);
    const key = messageKey(msg?.id) || (await echo);
    if (key) sentByBot.add(key);
    else log.warn('sent a message to the self-chat but could not learn its id; replies to it must quote the ref (e.g. Y A20)');
    return { key };
  }

  /** Sends one approval card and remembers which candidate it belongs to. */
  async function sendCard(candidate) {
    const bits = [];
    if (candidate.assignee) bits.push(`👤 ${candidate.assignee}`);
    if (candidate.dueDate) bits.push(`📅 ${formatDue(candidate.dueDate)}`);
    if (candidate.priority && candidate.priority !== 'medium') bits.push(`🎯 ${candidate.priority}`);

    const text = [
      `🔔 *Task detected* — ${candidate.chatLabel}`,
      '',
      `*[${candidate.ref}] ${candidate.title}*`,
      bits.length ? bits.join('   ') : null,
      candidate.notes ? `\n_${candidate.notes}_` : null,
      candidate.quote ? `\n💬 "${truncate(candidate.quote, 180)}"` : null,
      '',
      `Reply to this message:  *Y* add · *N* skip · *E <new title>* edit & add`,
    ]
      .filter((l) => l !== null)
      .join('\n');

    const sent = await send(text);
    if (sent?.key) store.attachApprovalMessage(candidate.ref, sent.key);
    log.info(`asked for approval [${candidate.ref}] ${candidate.title}`);
  }

  /**
   * Handles a message you typed in your own self-chat. Returns true if it was a
   * command we understood (so the caller knows not to process it further).
   */
  async function handleReply(msg, described) {
    if (noteEcho(described)) return true; // our own message echoing back, id now known
    if (sentByBot.has(described.id)) return true; // our own card echoing back
    const body = described.body.trim();
    if (!body) return false;
    // Belt and braces: message_create can fire for a card before sendMessage
    // resolves, so also recognise our own output by its shape.
    if (BOT_PREFIXES.some((p) => body.startsWith(p))) return true;
    log.info(`self-chat: "${body.slice(0, 40)}"${described.hasQuotedMsg ? ' (a reply to a card)' : ''}`);

    // 1. Reply-to-card form: quote the card and just say Y / N / E <title>
    if (described.hasQuotedMsg) {
      const quoted = await msg.getQuotedMessage();
      const candidate = store.getCandidateByApprovalMsg(messageKey(quoted.id));
      if (candidate) {
        const parsed = parseVerb(body);
        if (!parsed) {
          await send(`Didn't catch that. Reply *Y*, *N*, or *E <new title>* to card [${candidate.ref}].`);
          return true;
        }
        await applyDecision(candidate, parsed);
        return true;
      }
      // …or one of the dashboard's questions (link this shipment to a PO?)
      const card = findByWaMessage(store.landingDb(), messageKey(quoted.id));
      if (card?.needs_reply) {
        const parsed = parseVerb(body);
        if (!parsed || parsed.verb === 'e') {
          await send(`Didn't catch that. Reply *Y* or *N* to #${card.id}.`);
          return true;
        }
        await answerCard(card, parsed.verb === 'y' ? 'Y' : 'N');
        return true;
      }
    }

    // A dashboard question answered by its number: "Y #12" / "N #12"
    const answer = parseCardAnswer(body);
    if (answer) {
      const card = getCard(store.landingDb(), answer.id);
      if (!card?.needs_reply) await send(`No question #${answer.id} waiting for an answer.`);
      else await answerCard(card, answer.verb);
      return true;
    }

    // 2. Explicit-ref form: "y A3" / "A3 y" / "e A3 new title"
    const lower = body.toLowerCase();

    if (/^(pending|list|\?)$/.test(lower)) {
      await sendPendingList();
      return true;
    }
    if (/^help$/.test(lower)) {
      await send(HELP);
      return true;
    }
    if (/^(y|yes|approve)\s+all$/.test(lower) || /^(n|no|skip)\s+all$/.test(lower)) {
      const approve = /^(y|yes|approve)/.test(lower);
      const pending = store.listPending();
      if (!pending.length) {
        await send('Nothing pending.');
        return true;
      }
      for (const c of pending) await applyDecision(c, { verb: approve ? 'y' : 'n' }, true);
      await send(`${approve ? '✅ Added' : '🗑️ Skipped'} all ${pending.length} pending task(s).`);
      return true;
    }

    // The ref's letter is optional: "Y 15" means "Y A15" (every ref starts with A).
    const m = body.match(/^([a-z]+)?\s*([A-Za-z]?\d{1,3})\s*([a-z]+)?\s*(.*)$/i);
    if (m) {
      const [, verbBefore, rawRef, verbAfter, rest] = m;
      const ref = /^\d/.test(rawRef) ? `A${rawRef}` : rawRef.toUpperCase();
      const parsed = parseVerb(`${verbBefore || verbAfter || ''} ${rest || ''}`.trim());
      if (parsed) {
        const candidate = store.getCandidateByRef(ref);
        if (!candidate) {
          await send(`No task [${ref}]. Send *pending* to see what's waiting.`);
          return true;
        }
        await applyDecision(candidate, parsed); // says so if it was already decided
        return true;
      }
    }

    return false; // not a command — you were just typing a note to yourself
  }

  async function applyDecision(candidate, { verb, newTitle }, quiet = false) {
    if (candidate.status !== 'pending') {
      if (!quiet) await send(`[${candidate.ref}] was already ${candidate.status}.`);
      return;
    }

    if (verb === 'n') {
      store.decideCandidate(candidate.ref, 'rejected');
      log.info(`rejected [${candidate.ref}] ${candidate.title}`);
      if (!quiet) await send(`🗑️ Skipped [${candidate.ref}].`);
      return;
    }

    if (verb === 'e' && newTitle) {
      store.retitleCandidate(candidate.ref, newTitle);
      candidate = store.getCandidateByRef(candidate.ref);
    }

    // Approved tasks go on the dashboard's task board (Notion is no longer written to).
    try {
      const task = addWhatsAppTask(store.landingDb(), candidate, { actor: 'Ashar' });
      const link = config.dashboardUrl ? `${config.dashboardUrl.replace(/\/$/, '')}/tasks/${task.ref}` : null;
      store.decideCandidate(candidate.ref, 'approved', link);
      store.rememberFingerprint(store.fingerprintOf(candidate.chat_id, candidate.title), candidate.ref);
      log.ok(`added to the board [${candidate.ref}] ${candidate.title}`);
      if (!quiet) await send(`✅ Added: *${candidate.title}*${task.assignee ? ` (${task.assignee})` : ''}${link ? `\n${link}` : ''}`);
    } catch (err) {
      log.error(`Board write failed for [${candidate.ref}]:`, err.message);
      await send(`⚠️ Couldn't add [${candidate.ref}] to the task board: ${err.message}\nReply *Y ${candidate.ref}* to retry.`);
    }
  }

  /** Answers a dashboard question exactly as the Inbox buttons do. */
  async function answerCard(card, verb) {
    try {
      const out = await applyCardReply(store.landingDb(), card.id, verb, { actor: 'Ashar', client: amazonClient() });
      log.ok(`answered #${card.id} ${verb}: ${out.message}`);
      await send(`${out.ok ? '✅' : '⚠️'} #${card.id}: ${out.message}`);
    } catch (err) {
      log.error(`answer to #${card.id} failed:`, err.message);
      await send(`⚠️ Couldn't record your answer to #${card.id}: ${err.message}`);
    }
  }

  async function sendPendingList() {
    const pending = store.listPending();
    if (!pending.length) return send('✨ Nothing pending — you are all caught up.');
    const lines = pending.map(
      (c) => `*[${c.ref}]* ${c.title}${c.assignee ? ` — ${c.assignee}` : ''}${c.due_date ? ` (${formatDue(c.due_date)})` : ''}`
    );
    return send([`📋 *${pending.length} awaiting your call*`, '', ...lines, '', 'Reply *Y <ref>* / *N <ref>*, or *Y all*.'].join('\n'));
  }

  return { init, sendCard, handleReply, sendPendingList, send, selfChatId, isSelfChat, selfIds: () => selfIds, sentByBot, deliverOutbox: () => deliverOutbox(store.landingDb(), send) };
}

const BOT_PREFIXES = ['📥', '✏️', '🔔', '📋', '✅', '🗑️', '⚠️', '✨', '🔁', '📦', '🔗', '✂️', '💷', '🧾', '🗒️', '*Commands*', "Didn't catch that", 'No task [', 'No question #', 'Nothing pending', '['];

const HELP = `*Commands* (type these to yourself)
*Y* / *N* — reply to a task card to add or skip it
*E <new title>* — reply to a card to reword it, then add
*Y A3* / *N A3* — decide a card by its ref without replying
*Y all* / *N all* — clear the whole pending queue
*pending* — list everything awaiting your call
*Y #12* / *N #12* — answer a dashboard question (or reply to it with Y / N)`;

function parseVerb(text) {
  const t = text.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (/^(y|yes|yep|ok|okay|add|approve|1|👍)$/.test(lower)) return { verb: 'y' };
  if (/^(n|no|nope|skip|reject|2|👎)$/.test(lower)) return { verb: 'n' };
  const edit = t.match(/^(?:e|edit)\s+(.{3,})$/i);
  if (edit) return { verb: 'e', newTitle: edit[1].trim() };
  return null;
}

const formatDue = (iso) => shortDate(iso);

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
