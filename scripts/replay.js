/**
 * Tune detection without touching WhatsApp or Notion.
 *
 *   node scripts/replay.js samples/example.txt
 *   node scripts/replay.js samples/example.txt --both        compare gemini vs anthropic
 *   node scripts/replay.js samples/example.txt --image shot.png
 *   node scripts/replay.js --audio voice-note.ogg            transcribe only
 *   node scripts/replay.js samples/example.txt --audio note.ogg
 *
 * Transcript format is one message per line: "Name: message"
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadChats, config, assertProviderEnv, assertEnv } from '../src/config.js';
import { extractTasks } from '../src/extract/classifier.js';
import { transcribeAudio } from '../src/providers/gemini.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const VALUE_FLAGS = new Set(['audio', 'image', 'provider']);
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (VALUE_FLAGS.has(argv[i].slice(2))) i++; // skip its value
    continue;
  }
  positionals.push(argv[i]);
}
const transcriptFile = positionals[0] || null;
const audioFile = flag('audio');
const imageFile = flag('image');
const both = has('both');
const providers = both ? ['gemini', 'anthropic'] : [flag('provider') || config.provider];

if (!transcriptFile && !audioFile) {
  console.error('usage: node scripts/replay.js <transcript.txt> [--both] [--provider gemini|anthropic] [--audio note.ogg] [--image shot.png]');
  process.exit(1);
}

let people = {};
try { people = loadChats().people; } catch { /* allowlist not set up yet — fine */ }

const now = Math.floor(Date.now() / 1000);
const messages = [];

if (transcriptFile) {
  fs.readFileSync(transcriptFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const m = line.match(/^([^:]{1,30}):\s*(.+)$/);
      messages.push({
        author: m ? m[1].trim() : 'Unknown',
        body: m ? m[2].trim() : line,
        timestamp: now - (100 - i) * 60,
        attachments: [],
      });
    });
}

/* --- voice note: transcribe first, and show you exactly what it heard --- */
if (audioFile) {
  assertEnv(['geminiApiKey']);
  const data = fs.readFileSync(audioFile).toString('base64');
  const mime = mimeFor(audioFile);
  console.log(`\nTranscribing ${path.basename(audioFile)} with ${config.transcribeModel}…`);
  const started = Date.now();
  const text = await transcribeAudio({ mime, data });
  console.log(`\n\x1b[1mTRANSCRIPT\x1b[0m (${((Date.now() - started) / 1000).toFixed(1)}s)\n${text}\n`);
  messages.push({ author: 'Voice', body: text, timestamp: now, attachments: [], isVoiceNote: true });
}

if (imageFile) {
  messages.push({
    author: 'Ashar',
    body: '',
    timestamp: now,
    attachments: [{ kind: 'image', mime: mimeFor(imageFile), data: fs.readFileSync(imageFile).toString('base64'), filename: path.basename(imageFile) }],
  });
}

if (messages.length === 0) {
  console.log('Nothing to analyse.');
  process.exit(0);
}

for (const provider of providers) {
  process.env.LLM_PROVIDER = provider;
  config.provider = provider;
  try {
    assertProviderEnv();
  } catch (err) {
    console.log(`\n\x1b[33mSkipping ${provider}: ${err.message}\x1b[0m`);
    continue;
  }

  const label = provider === 'gemini' ? config.geminiModel : config.anthropicModel;
  console.log(`\n\x1b[1m── ${provider} / ${label} ──\x1b[0m`);
  const started = Date.now();

  const tasks = await extractTasks({
    chatId: 'replay',
    chatLabel: 'Replay',
    chatContext: 'Test transcript.',
    isGroup: true,
    messages,
    people,
    provider,
  });

  if (!tasks.length) {
    console.log('  No tasks detected.');
  } else {
    for (const t of tasks) {
      console.log(`\n  • ${t.title}`);
      console.log(`      assignee: ${t.assignee ?? '—'}   due: ${t.dueDate ?? '—'}   priority: ${t.priority}   confidence: ${t.confidence}`);
      if (t.notes) console.log(`      notes: ${t.notes}`);
      if (t.quote) console.log(`      quote: "${t.quote}"`);
    }
  }
  console.log(`\n  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
console.log();

function mimeFor(file) {
  return {
    '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
    '.wav': 'audio/wav', '.aac': 'audio/aac',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  }[path.extname(file).toLowerCase()] || 'application/octet-stream';
}
