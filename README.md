# Digi Merchant Automation — Phase 1: WhatsApp → Notion tasks

> **Access note:** the Notion board is for Ashar and Atif only. See
> [Keeping chats apart](#keeping-chats-apart) before sharing it with anyone else.

Watches the WhatsApp chats you choose, uses an LLM to spot real tasks in the conversation
— **text and voice notes**, including Urdu — asks you to confirm each one in your own
WhatsApp self-chat, and writes the approved ones into a Notion board you share with Atif
and Rafay.

```
WhatsApp (your number, allowlisted chats only)
   text · voice notes        (attachments built but switched off — see ROADMAP.md)
        ↓  voice → transcript
        ↓  buffered per chat, 90s of quiet = one conversation
Gemini or Claude → task candidates with assignee, due date, confidence
        ↓  duplicates and low-confidence guesses dropped silently
Approval card → your "Message yourself" chat:  Y / N / E <new title>
        ↓  only on Y
Notion "Digi Merchant Tasks"
```

Nothing reaches Notion without you saying yes.

---

## Which model, and what it costs

`LLM_PROVIDER` switches between **Gemini** (default) and **Claude**. Both handle text,
images and PDFs. The difference that matters here is audio:

|                        | Gemini | Claude |
|------------------------|--------|--------|
| Text, images, PDFs     | ✅ | ✅ |
| Voice notes            | ✅ natively | ❌ needs a separate transcriber |
| Billing                | Google AI Pro includes ~$10/mo Cloud credits | Separate prepaid credits — **not** included in Claude Pro |

Claude has no audio input at all, so with `LLM_PROVIDER=anthropic` you need
`TRANSCRIBER=whisper-local` (whisper.cpp on this Mac) for voice notes. That's also the
most private option — the audio never leaves the machine.

Either way the running cost is pennies a day; this is a small classifier, not a
reasoning job. Pick on capability, not price.

> **Set up Gemini billing before you start.** On Google's **free** tier your content may
> be used to improve Google's products and human reviewers can see it. Your ops chats
> contain supplier pricing, margins and VAT matters — enable Cloud Billing on the key so
> it's paid-tier, where that doesn't apply. Your AI Pro credits cover this many times over.

### Which tier for which job

The two media jobs fail in different ways, so they're configured separately:

| Job | Setting | Why |
|---|---|---|
| Plain chat | `GEMINI_MODEL` | Flash tier. This is a classifier, not a reasoning job. |
| Screenshots / PDFs | `GEMINI_VISION_MODEL` | **Point this at a Pro-tier model.** Dense Seller Central and Sellerboard tables are exactly where a Flash tier misreads a small figure — and a misread number becomes a wrong task you approve without noticing. Conversations with attachments are rare, so escalating only those costs very little. |
| Voice notes | `TRANSCRIBE_MODEL` | Transcription isn't reasoning-heavy; Flash is usually fine. Test it on your own audio. |

Images are also sent at `IMAGE_RESOLUTION=HIGH` (Google's own guidance: higher resolution
improves reading fine text), with the text prompt placed before the image, which their
docs say helps for text-in-image.

Model IDs move fast. Don't trust the defaults in `.env.example`:

```bash
npm run models
```

That lists what's actually live on your key.

---

## Setup (about 20 minutes, once)

### 1. Keys

Copy `.env.example` to `.env` and fill in `GEMINI_API_KEY` (billing enabled) and
`NOTION_API_KEY`.

### 2. Notion

1. Create an integration at <https://www.notion.so/my-integrations> → copy the secret.
2. In Notion, open the page the task board should live under → `⋯` → **Connections** →
   add your integration.
3. Pass that page's URL straight to the setup script.

```bash
npm run setup:notion -- https://www.notion.so/Your-Page-abc123
```

Not sure which pages the integration can reach? `npm run setup:notion -- --list`.

Note: an internal Notion integration cannot create top-level pages, so the board must live
under a page you create and share with it. Sharing is per-page and is not inherited from
the workspace — if you get `object_not_found`, the ⋯ → Connections step was missed.

Creates **Digi Merchant Tasks** with Task / Status / Assignee / Due / Priority / Source /
Captured / Confidence / Ref columns, and writes `NOTION_DATABASE_ID` back into `.env`.
**Share that page with Atif only. Do not share it with Rafay.** The board carries tasks
extracted from Ashar's direct chat with Atif, which covers supplier pricing, margins, and
market/product research that is deliberately not discussed with the VAs. Notion permissions
are page-level — anyone who can see the database sees every row in it, and there is no way
to hide individual rows from one collaborator.

### 3. Pick the chats to watch

```bash
npm run chats
```

Scan the QR once with **WhatsApp → Settings → Linked devices → Link a device**. It prints
every group and DM with its ID, then exits. Nothing is stored or sent.

```bash
cp config/chats.example.json config/chats.json
```

Paste in only the chats you want read. **Every other chat on your account is invisible**;
the allowlist is checked before a message is even looked at, let alone downloaded.

Fill in each chat's `context` field properly — it goes into the prompt and is the single
biggest lever on detection quality.

### 4. Tune it before going live

This is the step worth an hour. Everything runs offline — no WhatsApp, no Notion:

```bash
# text
npm run replay samples/example.txt

# compare Gemini vs Claude on identical input
npm run replay -- samples/example.txt --both

# an actual Urdu voice note — prints the transcript, then the tasks
npm run replay -- --audio ~/Downloads/voice-note.ogg

# a Seller Central or Sellerboard screenshot
npm run replay -- samples/example.txt --image ~/Desktop/shot.png
```

Export a few real voice notes from WhatsApp and run them through. That's how you find out
whether Urdu transcription is good enough for *your* accents and *your* product names —
which I can't tell you in advance, and neither can any benchmark.

### 5. Dry run for a day

```bash
caffeinate -i npm run dry 2>&1 | tee -a dryrun.log
```

`npm run dry` sets `DRY_RUN=true` and `DEBUG=1`. It watches your real chats and logs every
task it *would* have asked you to approve — **no WhatsApp messages are sent and nothing is
written to Notion**. Model calls still happen, so it still costs a few pence and your
messages still go to Google; that is the part being tested.

Four things to know before you leave it running:

- **`caffeinate -i` stops the Mac idling to sleep, but closing the lid still sleeps it.**
  Leave the lid open, or plug into an external display. A sleeping Mac catches nothing.
- **Closing the terminal kills it.** Keep the window open, or run it under `tmux`/`screen`.
- **Only messages that arrive after you start are seen.** `CATCH_UP_MINUTES=0` by default,
  so it does not go back over the morning's chat.
- **A conversation is only analysed after 90 seconds of quiet** (`FLUSH_IDLE_SECONDS`), so
  expect a lag between the chat happening and the log entry.

Stop it with Ctrl-C — that flushes anything still buffered and closes the browser cleanly.

### 6. Read the log, then tune

```bash
grep "asked for approval" dryrun.log     # what it would have surfaced
grep "no tasks in" dryrun.log            # conversations it let through
```

Judge it on two questions: did it miss anything you'd have wanted, and did it raise
anything you'd have been annoyed by. Misses usually mean the chat's `context` in
`config/chats.json` is too thin. Noise usually means raising `MIN_CONFIDENCE`, or tightening
the "What is NOT a task" list in [src/extract/prompt.js](src/extract/prompt.js).

### 7. Go live

```bash
npm run reset:queue
```

**Do this before your first real day.** A dry run still records candidates and their
duplicate fingerprints locally, so going straight to `npm start` would hand you a backlog of
cards for conversations you already reviewed, and silently suppress anything the dry run saw
for 14 days. Cached voice-note transcripts are kept.

Then set `DRY_RUN=false` in `.env` and:

```bash
caffeinate -i npm start
```

---

## Using it day to day

When a conversation goes quiet for 90 seconds, you get a card in your self-chat:

```
🔔 Task detected — Digi Merchant Ops (group)

[A7] Raise and pay PO for 5,000 gold leaf booklets (Shenzhen supplier)
👤 Atif   📅 Fri 28 Aug   🎯 high

💬 "can you get the PO raised and paid via Wise this week"

Reply to this message:  Y add · N skip · E <new title> edit & add
```

| You type | What happens |
|---|---|
| Reply `Y` to the card | Task created in Notion, link sent back |
| Reply `N` | Dropped |
| Reply `E Chase Shenzhen supplier for PO confirmation` | Reworded, then created |
| `Y A7` / `N A7` | Decide by ref without replying |
| `Y all` / `N all` | Clear the whole pending queue |
| `pending` | List everything awaiting your call |
| `help` | The above |

Anything else you type to yourself is left alone — it's still your notes chat.

---

## How media is handled

**If a voice note can't be read, you get told.** Linked devices don't hold media
themselves — the phone has to re-upload it. If your phone is offline, asleep, or slow, the
download fails and the message would otherwise vanish without trace, which is exactly the
"am I missing something important?" failure this system exists to prevent. Downloads are
retried three times, and if they still fail you get an alert in your self-chat naming the
sender and chat. Alerts are throttled to one per chat per 15 minutes, because an offline
phone fails every voice note in a row.

One format gotcha: WhatsApp voice notes are **OGG/Opus**, and Google's docs list OGG
*Vorbis* among supported formats. The native attempt is tried first, and if it's rejected
the audio is re-encoded to MP3 with ffmpeg and retried once (`brew install ffmpeg`), rather
than silently losing the message. Set `AUDIO_FFMPEG_FALLBACK=false` to turn that off.

**Voice notes** are transcribed first, then the transcript goes into the conversation like
any other message: `Rafay (voice note): "..."`. Transcribing before reasoning (rather than
handing raw audio to the extractor) is deliberate — both providers then see identical
input so the `--both` comparison is fair, the transcript lands on the approval card where
you can sanity-check it, and a bad transcription is visible rather than hidden inside a
wrong task. Transcripts are cached by message ID, so no audio is ever paid for twice.

Urdu, Roman Urdu, English and mid-sentence code-switching are all handled, and the prompt
tells the model to expect transcription errors: read through the noise, but if a **number
or a name** is central and looks garbled, lower the confidence and flag the doubt in the
notes rather than inventing a figure. You are the check on this, which is exactly what the
confirmation step is for.

**Attachments are all off by default** — `ENABLE_IMAGES=false` and `ENABLE_DOCUMENTS=false`.
Phase 1 is text and voice notes only. The rest of this section describes what happens when
you turn them on for the receipts work; see [ROADMAP.md](ROADMAP.md).

**Images**, when enabled, go to the model with their caption and surrounding chat — Seller Central alerts,
Sellerboard graphs, supplier quotes, listing mock-ups. The prompt requires it to read the
actual figures, ASINs and campaign names off the screenshot rather than saying "the number
in the image". An attachment on its own is never a task; there must still be an ask.

**PDFs** are sent as documents. **Spreadsheets** are flattened to a text table, capped at 60
rows per sheet — a 10,000-row stock report would swamp the conversation and the ask is
always in the first screenful.

Video, stickers, locations and contacts are ignored. Anything over `MAX_ATTACHMENT_MB`
(default 8MB) is skipped with a log line.

---

## Keeping chats apart

Chats differ in how sensitive they are. The Amazon VA group is execution work the VAs are
already part of; the direct chat with Atif also carries supplier pricing, margins, and
market research that is deliberately kept from them.

Because Notion permissions are page-level, a single shared board leaks the second into the
first. Two things follow:

1. **The board is not shared with Rafay.** He continues to receive his work over WhatsApp.
2. **Routing is by chat, never by topic.** Each entry in `config/chats.json` may set its own
   `notionDatabaseId`; tasks from that chat go to that board and no other. Asking the model
   to judge which individual tasks are sensitive would be the wrong design — one
   misclassification is permanent and silent, whereas which chat a message came from is a
   fact rather than a judgement.

If you later want Rafay to have a board of his own, create a second database, put its ID on
the group's entry in `config/chats.json`, and share only that one with him:

```json
{ "id": "1203…@g.us", "label": "Amazon VA (group)", "notionDatabaseId": "<the shared board>" }
```

A chat with no `notionDatabaseId` falls back to `NOTION_DATABASE_ID` from `.env`.

### Assignment rules

A chat can also set `unknownAssignee`. Any assignee the model returns that isn't on the
roster is mapped to that person instead. The Amazon VA group uses this: there is a third VA
whom Atif manages directly, so tasks landing on that VA are assigned to Atif. The chat's
`context` states the same rule in prose so the model applies it too — the config setting is
the deterministic backstop for when it doesn't.

---

## What stops it being noisy

This is the part that decides whether you keep it running:

- **Conversation batching.** Messages are grouped per chat and only sent after 90 seconds
  of quiet. A single message is usually meaningless — "ok do that one first" is only a
  task in context.
- **A conservative prompt.** Status updates, opinions, shared numbers and vague intentions
  are explicitly listed as *not* tasks. "I finished the A+ content yesterday" must not
  become a task.
- **A confidence floor.** Anything under `MIN_CONFIDENCE` (0.55) is dropped without
  bothering you. Raise it if you're getting too many cards.
- **Duplicate suppression.** Word-set fingerprints per chat over a 14-day window, so the
  same reorder discussed Monday and Wednesday only asks you once.

Tuning knobs live in `.env`; the actual judgement lives in `src/extract/prompt.js`.

---

## A note on whatsapp-web.js drift

WhatsApp Web changes its internals; the library follows behind. Three of its APIs are
broken against the current build, and all three are worked around here rather than waited on:

| Broken | Symptom | Worked around by |
|---|---|---|
| `msg.id._serialized` | undefined everywhere — silently broke dedupe, the transcript cache, reply-to-approve, and media downloads | [`src/whatsapp/ids.js`](src/whatsapp/ids.js) builds the key from `{fromMe, remote, id}` |
| `Msg.get()` / `getMessagesById()` | throws a minified `r`; also breaks `client.getMessageById()` | [`src/whatsapp/media.js`](src/whatsapp/media.js) matches the loaded collection on the message hash |
| `client.getChats()` | one unserialisable chat rejects the whole listing | [`scripts/list-chats.js`](scripts/list-chats.js) reads the raw collection, skipping bad entries |

`npm run diagnose:media` is the tool for the next one of these. It catches errors *inside*
the page and serialises them there — errors thrown in page context arrive at Node with an
empty message, which is why the original failure logged as nothing at all.

If media or dedupe breaks again after a WhatsApp update, run it first.

---

## Risks, stated plainly

**WhatsApp.** This uses `whatsapp-web.js`, which drives a real WhatsApp Web session. It is
not an official Meta API, and automating a personal account is against WhatsApp's Terms of
Service. Bans in practice target bulk unsolicited sending, which this doesn't do — it reads
allowlisted chats and only ever messages *you*, never Atif, Rafay or a customer. Low
exposure, not zero. If the number becomes commercially critical, the official alternative
is the WhatsApp Business Cloud API on a separate number — but that can't read your existing
groups, which is the whole point here.

**Data.** Voice notes, screenshots and supplier PDFs from allowlisted chats are sent to
Google (or Anthropic). Use a billing-enabled key so it isn't training data. If a particular
chat is too sensitive for that, leave it out of the allowlist — or run
`TRANSCRIBER=whisper-local` so at least the audio stays on your Mac.

**Uptime.** Your Mac must be awake to catch messages — a sleeping Mac catches nothing and
there is no backlog to recover. `CATCH_UP_MINUTES` handles only short gaps. For a real
always-on setup, see **[DEPLOY.md](DEPLOY.md)** (~£4/month VPS, about 30 minutes).

---

## Layout

```
src/
  index.js              wiring: intake → media → buffer → classify → approve
  config.js             env, provider selection, chat allowlist
  whatsapp/client.js    whatsapp-web.js session, QR, message shape
  whatsapp/approval.js  approval cards and reply parsing
  media/ingest.js       one message in, one buffer-ready message out
  media/download.js     download, type classification, size guards
  media/transcribe.js   voice note → text (Gemini or local whisper.cpp), cached
  media/documents.js    xlsx/csv → text table
  extract/buffer.js     per-chat conversation batching
  extract/prompt.js     ← the prompt. Most quality lives here.
  extract/classifier.js provider-agnostic extraction + normalisation
  providers/gemini.js   text, images, PDFs, audio
  providers/anthropic.js text, images, PDFs
  providers/schema.js   one task schema, two dialects
  tasks/notion.js       Notion adapter (swap this to change task board)
  store/db.js           SQLite: dedupe, transcripts, pending queue, decisions
scripts/
  list-chats.js         print chat IDs for the allowlist
  setup-notion.js       one-time database creation
  models.js             what's live on your Gemini key
  replay.js             test detection offline, compare providers
```

`tasks/notion.js` is the only file that knows about Notion, and `providers/` the only ones
that know about a model vendor. Swapping either is one new adapter, not a rewrite.

---

## What's next

See [ROADMAP.md](ROADMAP.md). Headline: **attachment ingestion is built but switched off**
(`ENABLE_IMAGES=false`, `ENABLE_DOCUMENTS=false`) — task capture doesn't need it. It gets
turned back on for the receipts → landing-cost work, which is the next item.
