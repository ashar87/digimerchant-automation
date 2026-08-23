import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '../config.js';
import { log } from '../logger.js';
import { transcribeAudio as geminiTranscribe } from '../providers/gemini.js';
import { getTranscript, saveTranscript } from '../store/db.js';
import { cacheToDisk } from './download.js';

const run = promisify(execFile);

/**
 * Voice note -> text. Transcripts are cached by message id, so a restart or a
 * re-run never pays for the same audio twice.
 *
 * We deliberately transcribe first and reason second, rather than handing raw
 * audio to the extractor. It means both providers see identical input (so the
 * replay comparison is fair), the transcript can be shown on the approval card
 * for you to sanity-check, and a bad transcription is visible rather than hidden
 * inside a wrong task.
 */
export async function transcribe(attachment, messageId) {
  const cached = getTranscript(messageId);
  if (cached !== undefined) return cached;

  let text = null;
  const started = Date.now();
  try {
    if (config.transcriber === 'none') return null;
    text = config.transcriber === 'whisper-local'
      ? await whisperLocal(attachment, messageId)
      : await geminiWithFallback(attachment, messageId);
  } catch (err) {
    log.error(`transcription failed (${config.transcriber}):`, err.message);
    return null;
  }

  text = (text || '').trim();
  if (!text) return null;

  saveTranscript(messageId, text);
  log.info(`transcribed ${(attachment.bytes / 1024).toFixed(0)}KB voice note in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return text;
}

/**
 * WhatsApp voice notes are OGG/Opus. Google's docs list OGG *Vorbis* among the
 * supported formats, so Opus may or may not be accepted depending on the model.
 * Try it natively first — and if that's rejected, re-encode to MP3 and retry once
 * rather than silently losing the message.
 */
async function geminiWithFallback(attachment, messageId) {
  try {
    return await geminiTranscribe({ mime: attachment.mime, data: attachment.data });
  } catch (err) {
    if (!config.audioFfmpegFallback) throw err;
    log.warn(`native ${attachment.mime} rejected (${err.message.split('\n')[0]}) — re-encoding to mp3 and retrying`);
    const mp3 = await reencode(attachment, messageId, 'mp3', ['-c:a', 'libmp3lame', '-b:a', '64k']);
    try {
      return await geminiTranscribe(mp3);
    } finally {
      fs.rmSync(mp3.path, { force: true });
    }
  }
}

/**
 * whisper.cpp on this machine — nothing leaves the Mac.
 *   brew install whisper-cpp ffmpeg
 *   curl -L -o ~/ggml-large-v3.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
 */
async function whisperLocal(attachment, messageId) {
  // whisper.cpp wants 16kHz mono PCM.
  const wav = await reencode(attachment, messageId, 'wav', ['-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le']);
  const outBase = wav.path.replace(/\.wav$/, '');

  const args = ['-m', config.whisperModelPath, '-f', wav.path, '-otxt', '-of', outBase, '-np'];
  if (config.whisperLanguage && config.whisperLanguage !== 'auto') args.push('-l', config.whisperLanguage);

  try {
    await run(config.whisperCli, args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`${config.whisperCli} failed (${firstLine(err)}). Install it with: brew install whisper-cpp`);
  }

  const txtPath = `${outBase}.txt`;
  const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : '';

  fs.rmSync(wav.path, { force: true });
  fs.rmSync(txtPath, { force: true });
  return text;
}

/** Re-encodes an audio attachment via ffmpeg. Returns { mime, data, path }. */
async function reencode(attachment, messageId, ext, codecArgs) {
  const source = cacheToDisk(attachment, messageId);
  const out = path.join(os.tmpdir(), `${path.basename(source, path.extname(source))}.${ext}`);

  try {
    await run('ffmpeg', ['-y', '-i', source, ...codecArgs, out]);
  } catch (err) {
    throw new Error(`ffmpeg failed converting the voice note (${firstLine(err)}). Install it with: brew install ffmpeg`);
  }

  return {
    mime: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    data: fs.readFileSync(out).toString('base64'),
    path: out,
  };
}

const firstLine = (err) => String(err.message || err).split('\n')[0];
