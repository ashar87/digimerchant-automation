/**
 * The listener's side of the supplier group ("files" in config/chats.json):
 * files are downloaded whatever ENABLE_IMAGES / ENABLE_DOCUMENTS say, collected
 * per sender with the replies they answer and the amount the sender asks to be
 * sent, and handed to intakeGroupFiles; Wise payment messages are noted and set
 * against what was asked. Nothing is posted in the group: the cards go to the
 * self-chat.
 */
import { config } from '../config.js';
import { downloadAttachment } from '../media/download.js';
import { createSpApi, spApiConfigured } from '../amazon/spapi.js';
import { geminiInvoiceReader } from '../invoices/model.js';
import { geminiBillReader } from '../bills/read.js';
import { enqueue } from '../notify/outbox.js';
import { noteWiseMessage, parseWiseMessage } from '../wise/whatsapp.js';
import { fmtMoney } from '../landing/money.js';
import { intakeGroupFiles, geminiLabeller, createBursts } from './group.js';
import { parseRequest, noteRequest, applyPayment, noteReply, replyChain, fmtAmount } from './requests.js';

const EXT = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** "WhatsApp Image 2026-10-28 at 15.17.29.jpeg", as WhatsApp names a saved photo: the bill date is read from it. */
export function whatsappName(timestamp, mime, timeZone = config.timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(timestamp * 1000))
      .map((x) => [x.type, x.value]),
  );
  return `WhatsApp ${mime === 'application/pdf' ? 'Document' : 'Image'} ${p.year}-${p.month}-${p.day} at ${p.hour}.${p.minute}.${p.second}.${EXT[mime] || 'bin'}`;
}

export function createGroupIntake({ client, chats, db, log, onQueued = () => {}, idleMs = 90_000 }) {
  const groups = new Map((chats.files || []).filter((c) => c.id).map((c) => [c.id, { label: c.label || c.name || c.id }]));
  let readers;
  const ready = async () => {
    if (readers) return readers;
    // Paid Gemini reads the files; without a key they still become drafts, typed in by hand.
    const gemini = config.geminiApiKey ? await import('../providers/gemini.js') : null;
    readers = {
      labeller: gemini ? geminiLabeller(gemini) : { label: async () => ({ kind: 'supplier_invoice' }) },
      invoiceReader: gemini ? geminiInvoiceReader(gemini) : null,
      billReader: gemini ? geminiBillReader(gemini) : null,
      amazon: spApiConfigured(config.spapi) ? createSpApi(config.spapi) : null,
    };
    return readers;
  };

  const bursts = createBursts({
    idleMs,
    onFlush: async ({ author, chatLabel, asked }, files) => {
      try {
        const out = await intakeGroupFiles({ db: db(), files, author, chatLabel, asked, ...(await ready()) });
        log.ok(`[${chatLabel}] ${files.length} file(s) from ${author}: ${out.map((o) => (o.draft ? `${o.kind} draft ${o.draft.id}${o.corrects ? ' (corrected version)' : ''}` : o.error ? `${o.kind} failed: ${o.error}` : `${o.skipped} ${o.kind} file(s) left alone`)).join(', ')}`);
      } catch (err) {
        log.error(`[${chatLabel}] taking in ${files.length} file(s) from ${author} failed:`, err.message);
        enqueue(db(), { kind: 'group_error', text: `⚠️ Couldn’t take in ${files.length} file(s) from ${author} in ${chatLabel}: ${err.message}. Upload them on the dashboard instead.` });
      }
      onQueued();
    },
  });

  /** Finds the groups named in config/chats.json among WhatsApp's chats, and says which it's reading. */
  async function resolve() {
    const wanted = (chats.files || []).filter((c) => !c.id);
    if (wanted.length) {
      let all = [];
      try {
        all = await client.pupPage.evaluate(() =>
          window.require('WAWebCollections').Chat.getModelsArray().map((c) => ({ id: c.id?._serialized, name: c.formattedTitle ?? c.name ?? null })),
        );
      } catch (err) {
        log.error('could not list chats to find the supplier group:', err.message);
      }
      const key = (s) => String(s || '').trim().toLowerCase();
      for (const c of wanted) {
        const hits = all.filter((x) => x.id?.endsWith('@g.us') && key(x.name) === key(c.name));
        if (hits.length === 1) groups.set(hits[0].id, { label: c.label || c.name });
        else {
          log.warn(`files: ${hits.length ? 'more than one' : 'no'} group called "${c.name}" — add its id to config/chats.json`);
          enqueue(db(), { kind: 'group_error', dedupeKey: `group-missing:${c.name}:${hits.length}`, text: `⚠️ Can’t find ${hits.length ? 'just one' : 'the'} WhatsApp group “${c.name}”, so its invoices and bills aren’t being read. Add the group’s id to config/chats.json.` });
          onQueued();
        }
      }
    }
    for (const [id, g] of groups) log.info(`   • ${g.label} (invoices, courier bills and Wise payments only: ${id})`);
  }

  /** The messages this one replies to, nearest first (its corrected version's original is among them). */
  async function repliesOf(msg, messageId, timestamp) {
    const quoted = msg._data?.quotedStanzaID || null;
    if (!quoted) return [];
    noteReply(db(), { id: messageId, quoted, timestamp });
    const chain = replyChain(db(), quoted);
    if (chain.length === 1) {
      // The message it quotes came in while the listener was off: ask WhatsApp what that one quotes.
      try {
        const q = await msg.getQuotedMessage();
        const next = q?._data?.quotedStanzaID;
        if (next) chain.push(...replyChain(db(), next).filter((id) => !chain.includes(id)));
      } catch {}
    }
    return chain;
  }

  async function handle(msg, m) {
    const { label } = groups.get(m.chatId);
    const messageId = msg.id?.id || m.id;
    const burst = `${m.chatId}|${m.author}`;
    const repliesTo = await repliesOf(msg, messageId, m.timestamp);
    const ask = !m.fromMe && !m.hasMedia ? parseRequest(m.body || '') : null;
    if (ask) {
      noteRequest(db(), { id: messageId, chat: m.chatId, author: m.author, timestamp: m.timestamp, ...ask });
      const joined = bursts.note(burst, { asked: ask });
      log.info(`[${label}] ${m.author} asks for ${fmtAmount(ask.currency, ask.amount)} to be sent${joined ? ', for the files just sent' : ''}`);
    }
    if (m.hasMedia) {
      const att = await downloadAttachment(msg, m, { force: true });
      if (att) {
        const filename = att.filename || whatsappName(m.timestamp, att.mime);
        bursts.add(burst, { author: m.author, chatLabel: label }, { buffer: Buffer.from(att.data, 'base64'), filename, mime: att.mime, messageId, repliesTo });
        log.info(`[${label}] ${att.kind} from ${m.author}, waiting for the rest of what they send`);
      } else if (m.downloadFailure) {
        enqueue(db(), { kind: 'group_error', text: `⚠️ Couldn’t download a file ${m.author} sent in ${label} (${m.downloadFailure.reason}). If it’s an invoice or bill, upload it on the dashboard.` });
        onQueued();
      }
    }
    if (parseWiseMessage(m.body || '')) {
      try {
        const t = await noteWiseMessage(db(), { id: m.id, timestamp: m.timestamp, body: m.body });
        if (!t) return;
        const sent = t.usd ? ['USD', t.usd] : t.cny ? ['CNY', t.cny] : null;
        const against = sent ? applyPayment(db(), { chat: m.chatId, currency: sent[0], amount: sent[1], timestamp: m.timestamp }) : null;
        log.ok(`[${label}] Wise payment noted: ${sent ? fmtAmount(...sent) : '?'}, GBP ${t.gbp ? `from the ${t.gbpFrom}` : `not found${t.linkError ? ` (${t.linkError})` : ' on the page'}`}`);
        const link = config.dashboardUrl ? `${config.dashboardUrl.replace(/\/$/, '')}/payments/new?wise=${encodeURIComponent(t.id)}` : 'Dashboard → Payments → From Wise';
        enqueue(db(), {
          kind: 'group_wise',
          dedupeKey: `group:wise:${t.id}`,
          text: [
            `💷 Wise payment in ${label}${sent ? `: ${fmtAmount(...sent)} sent` : ''}${t.recipient ? ` to ${t.recipient}` : ''}`,
            against,
            t.gbp ? `£${fmtMoney(t.gbp)} paid (from the ${t.gbpFrom === 'link' ? 'Wise page' : 'message'})` : 'The GBP it cost isn’t on the Wise page: type it in when you record it.',
            `Record it: ${link}`,
          ].filter(Boolean).join('\n'),
        });
        onQueued();
      } catch (err) {
        log.error(`[${label}] could not note the Wise payment:`, err.message);
      }
    }
  }

  return { has: (id) => groups.has(id), resolve, handle, flushAll: () => bursts.flushAll() };
}
