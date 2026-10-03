# Automation roadmap

What's built, what's deliberately parked, and what comes next. Each item says what
already exists in the codebase to support it, so picking one up doesn't mean starting cold.

---

## ✅ Phase 1 — WhatsApp → Notion task capture

Live. Text and voice notes from allowlisted chats → task candidates → your approval →
Notion. See [README.md](README.md).

---

## 🅿️ Parked — attachment ingestion (images, PDFs, spreadsheets)

**Status:** code complete, switched off via `ENABLE_IMAGES=false` and
`ENABLE_DOCUMENTS=false`.

Phase 1 runs on **text and voice notes only**. Turned off because task capture doesn't
need attachments — the tasks in your ops chats come from what people *say*, not from what
they paste. Nothing is downloaded, sent to any model, or paid for.

Everything needed to turn it back on already exists and is tested:

- `src/media/download.js` — classifies and size-guards images, PDFs and spreadsheets
- `src/media/documents.js` — xlsx/csv → text table, capped at 60 rows per sheet
- `src/media/ingest.js` — attaches them to the conversation
- `src/providers/gemini.js` — per-part `MEDIA_RESOLUTION_HIGH` for reading fine print
- `GEMINI_VISION_MODEL` — auto-escalates to a Pro-tier model when a conversation carries
  an image or PDF, so dense screenshots don't get read by a Flash model
- `npm run replay -- --image shot.png` — test it offline before trusting it

**To re-enable:** set `ENABLE_IMAGES=true` and/or `ENABLE_DOCUMENTS=true`. That's the
whole change — no code to restore.

Note that with all attachments off, the `GEMINI_VISION_MODEL` escalation never fires, so
every call runs on the cheap Flash model. That's the intended state for now.

---

## 🎯 Next — receipts & supplier invoices → landing-cost workbook

> **In progress as a landing-cost system** (the plan is in `private/landing-cost-plan.html`).
> Phase 1 is built: `src/landing/` holds the data model (`store.js`, its own
> `data/landing.db`) and the cost engine (`engine.js`). `npm test` runs the rule tests;
> `npm run landing:check` reproduces the sourcing sheet from raw payments and bills, using
> fixtures in `private/fixtures/landing/` that are never committed. Phase 2 is built too: the
> dashboard (`npm run dashboard`) and the importer for the open orders
> (`npm run landing:import`). Phase 3, the Amazon sync (`npm run amazon:sync`) and the WhatsApp
> card queue, is built and waiting for SP-API keys; the listener doesn't send from the queue
> yet. Phase 4 (courier bills in the dashboard, the Sellerboard feed, nightly encrypted
> backups) is built and waiting for a Google service account. Invoice reading (below) is phase 5.

The real reason image support was built. This is the highest-value item on the list
because it removes manual data entry from something you already do every time you pay a
supplier.

**The idea.** Supplier invoices and courier invoices arrive in WhatsApp as photos or PDFs.
Today you read them and hand the numbers over. Instead: detect an invoice in the chat,
extract the fields, and hand a filled-in brief to the `amazon-fba-landing-cost` skill,
which builds the payment tab and computes per-unit landing cost.

**Fields the skill needs** (from its SKILL.md — this is the extraction target):

| Field | Usually from |
|---|---|
| Payment date | Wise transaction, not the invoice |
| Marketplace (UK / US / DE / Courier) | context, or the invoice's ship-to |
| Sheet type: inventory vs courier | which supplier sent it |
| Funding currency (GBP/EUR/USD/CNY) + amount | Wise, you |
| USD transferred | Wise (omit when funded in CNY) |
| QB rate | needed for EUR funding, or US marketplace funded from GBP/EUR |
| Deposit status: 30% / 70% / 100% | the invoice or the chat around it |
| If 70% — which tab holds the 30% | the workbook |
| Per invoice: label, USD amount, RMB per product line | **the invoice image/PDF** |
| Per product: SKU/name, quantity | **the invoice image/PDF** |
| R&D lines | you — must be confirmed, never guessed |

**Design notes for whoever builds this:**

- Only the bottom two rows are genuinely extractable from the document. Everything above
  comes from Wise or from you — so this is an *assisted* flow, not a fully automatic one.
  The right output is a pre-filled brief with the invoice lines already read, and gaps
  clearly marked for you to fill.
- **Never let a model guess a number it couldn't read.** Landing cost feeds pricing and
  margin. Unreadable figures must come back as blanks with the crop attached, not as a
  plausible-looking value. The same rule already applies to garbled voice notes in
  `src/extract/prompt.js` — reuse that stance.
- Use `GEMINI_VISION_MODEL` at a Pro tier and `IMAGE_RESOLUTION=ULTRA_HIGH` here. This is
  the one job where misreading a digit is expensive.
- The confirmation step should show extracted figures **next to the source crop**, not on
  their own. A number you can't check against the image is a number you'll rubber-stamp.
- Trigger should be explicit, not ambient — an invoice in a chat is not always a payment
  you've made. Something like replying `invoice` to the message, or a dedicated chat.

**Prerequisite:** `ENABLE_IMAGES=true` and `ENABLE_DOCUMENTS=true` — both currently off.

---

## Later

### Reorder alerts
Inventory + sales velocity → "Gold leaf UK has 19 days cover, lead time is 45 — raise a
PO?" as an approval card. Same skeleton as phase 1: scheduled job → model → card → action.
**Needs:** Amazon SP-API, or a Sellerboard export.

### PPC health
Daily ACOS / spend / wasted-spend scan. Only surfaces campaigns that *actually moved*,
with the specific bid or negative-keyword change to approve — not a dashboard you have to
read. Rafay is the natural assignee for whatever comes out of it.
**Needs:** Amazon Ads API.

### Weekly business pulse
Sales, margin after landing cost, cash position, and what slipped. Reuses the landing-cost
data above, which is a reason to do receipts first.
**Needs:** the receipts work, plus SP-API.

### Product research
Candidate ASINs scored against your criteria, queued for review rather than pushed.
**Needs:** a data source and, more importantly, your criteria written down.

---

## Notes on sequencing

Receipts before reorder alerts, and reorder alerts before the pulse. Landing cost is an
input to margin, so building the pulse first means building it twice.

Don't start phase 2 until phase 1 has run for a few weeks and you actually trust the
cards. The failure mode for all of this is the same: too many low-quality prompts, you
stop reading them, the system quietly becomes noise.
