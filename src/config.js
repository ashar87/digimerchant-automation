import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, fallback) => (v === undefined || v === '' ? fallback : String(v).toLowerCase() === 'true');
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

export const config = {
  /* --- which model reads your chats --- */
  provider: (process.env.LLM_PROVIDER || 'gemini').toLowerCase(),

  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  // Used only when a conversation carries a screenshot or PDF. Dense Seller Central
  // tables are where a Flash tier is most likely to misread a figure, and those
  // conversations are rare, so escalating them costs almost nothing.
  geminiVisionModel: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  transcribeModel: process.env.TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  anthropicVisionModel: process.env.ANTHROPIC_VISION_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  /* --- media --- */
  enableImages: bool(process.env.ENABLE_IMAGES, true),
  enableVoiceNotes: bool(process.env.ENABLE_VOICE_NOTES, true),
  enableDocuments: bool(process.env.ENABLE_DOCUMENTS, true),
  // 'gemini' = send the audio to Gemini; 'whisper-local' = whisper.cpp on this Mac; 'none' = skip voice notes.
  transcriber: (process.env.TRANSCRIBER || 'gemini').toLowerCase(),
  whisperCli: process.env.WHISPER_CLI || 'whisper-cli',
  whisperModelPath: process.env.WHISPER_MODEL_PATH,
  whisperLanguage: process.env.WHISPER_LANGUAGE || 'auto',
  maxAttachmentMb: num(process.env.MAX_ATTACHMENT_MB, 8),
  // LOW | MEDIUM | HIGH | ULTRA_HIGH — higher reads fine print better, costs more tokens.
  imageResolution: (process.env.IMAGE_RESOLUTION || 'HIGH').toUpperCase(),
  // WhatsApp voice notes are OGG/Opus; Google documents OGG *Vorbis*. If a native
  // attempt is rejected, re-encode with ffmpeg and retry once.
  audioFfmpegFallback: bool(process.env.AUDIO_FFMPEG_FALLBACK, true),

  /* --- notion --- */
  notionApiKey: process.env.NOTION_API_KEY,
  notionDatabaseId: process.env.NOTION_DATABASE_ID,
  notionParentPageId: process.env.NOTION_PARENT_PAGE_ID,

  /* --- behaviour --- */
  flushIdleSeconds: num(process.env.FLUSH_IDLE_SECONDS, 90),
  flushMaxMessages: num(process.env.FLUSH_MAX_MESSAGES, 25),
  minConfidence: num(process.env.MIN_CONFIDENCE, 0.55),
  dryRun: bool(process.env.DRY_RUN, false),
  catchUpMinutes: num(process.env.CATCH_UP_MINUTES, 0),
  // If WhatsApp never becomes ready, exit so the service manager restarts us.
  readyTimeoutSeconds: num(process.env.READY_TIMEOUT_SECONDS, 180),
  expirePendingDays: num(process.env.EXPIRE_PENDING_DAYS, 7),

  // The business's timezone, not the server's — see src/util/time.js.
  timezone: process.env.TZ || 'Europe/London',

  dbPath: path.join(ROOT, 'data', 'automation.db'),
  /* --- Amazon Selling Partner API (landing-cost sync). Disabled until filled in. --- */
  spapi: {
    clientId: process.env.SPAPI_LWA_CLIENT_ID,
    clientSecret: process.env.SPAPI_LWA_CLIENT_SECRET,
    // One authorisation per region: EU covers UK and DE, NA covers the US.
    refreshTokens: { EU: process.env.SPAPI_REFRESH_TOKEN_EU, NA: process.env.SPAPI_REFRESH_TOKEN_NA },
  },

  /* --- Sellerboard cost feed: a Google Sheet Sellerboard reads daily. Off until filled in. --- */
  sellerboard: {
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
    sheetId: process.env.SELLERBOARD_SHEET_ID,
    tab: process.env.SELLERBOARD_SHEET_TAB || 'COGS',
  },

  /* --- Wise: read transfers to suggest payments. Off until a token is set. --- */
  wise: { token: process.env.WISE_API_TOKEN, profileId: process.env.WISE_PROFILE_ID || null },

  /* --- QuickBooks Online: exchange rates for the payment date. Off until filled in. --- */
  qbo: {
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    realmId: process.env.QBO_REALM_ID,
    refreshToken: process.env.QBO_REFRESH_TOKEN,
    environment: process.env.QBO_ENVIRONMENT || 'production',
  },

  /* --- Nightly encrypted backup of the landing-cost database --- */
  backup: {
    passphrase: process.env.BACKUP_PASSPHRASE,
    dir: process.env.BACKUP_DIR || path.join(ROOT, 'data', 'backups'),
    keep: num(process.env.BACKUP_KEEP, 30),
  },

  // Landing-cost records live apart from the listener's queue, so neither can corrupt the other.
  // Where the dashboard is reached (e.g. the Tailscale address); used for links in WhatsApp replies.
  dashboardUrl: process.env.DASHBOARD_URL || null,
  landingDbPath: process.env.LANDING_DB_PATH || path.join(ROOT, 'data', 'landing.db'),
  sessionPath: path.join(ROOT, 'data', 'wa-session'),
  // Pin WhatsApp Web to a version the library can drive, served from data/wa-web/<version>.html.
  // For when WhatsApp ships a build whose internals whatsapp-web.js can't reach yet. Blank = live.
  waWebVersion: process.env.WA_WEB_VERSION || null,
  // When the archive says that build stops being accepted; the Inbox warns two weeks before.
  waWebVersionExpires: process.env.WA_WEB_VERSION_EXPIRES || null,
  waWebCachePath: path.join(ROOT, 'data', 'wa-web'),
  mediaCachePath: path.join(ROOT, 'data', 'media'),
};

const chatsPath = path.join(ROOT, 'config', 'chats.json');
const PLACEHOLDERS = ['447700900123', '120363000000000000'];

/** Loads the chat allowlist. Nothing outside `watch` is ever read. */
export function loadChats() {
  if (!fs.existsSync(chatsPath)) {
    throw new Error(
      `Missing config/chats.json.\n` +
        `  1. npm run chats     (prints every chat and its ID)\n` +
        `  2. cp config/chats.example.json config/chats.json\n` +
        `  3. paste in the IDs of the chats you want watched.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(chatsPath, 'utf8'));
  const watch = (raw.watch || []).filter((c) => c.id && !PLACEHOLDERS.some((p) => c.id.startsWith(p)));
  if (watch.length === 0) {
    throw new Error('config/chats.json has no real chats in "watch" — it still holds the example placeholders.');
  }
  return {
    watch,
    byId: new Map(watch.map((c) => [c.id, c])),
    people: raw.people || {},
  };
}

export function assertEnv(keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')} — see .env.example`);
}

/** Checks only what the selected provider and transcriber actually need. */
export function assertProviderEnv() {
  if (config.provider === 'gemini') assertEnv(['geminiApiKey']);
  else if (config.provider === 'anthropic') assertEnv(['anthropicApiKey']);
  else throw new Error(`LLM_PROVIDER must be "gemini" or "anthropic", got "${config.provider}"`);

  if (config.enableVoiceNotes && config.transcriber === 'gemini') assertEnv(['geminiApiKey']);
  if (config.enableVoiceNotes && config.transcriber === 'whisper-local' && !config.whisperModelPath) {
    throw new Error('TRANSCRIBER=whisper-local needs WHISPER_MODEL_PATH pointing at a ggml model file');
  }
}
