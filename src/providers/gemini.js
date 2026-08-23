import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { geminiSchema } from './schema.js';

let client;
const api = () => (client ??= new GoogleGenAI({ apiKey: config.geminiApiKey }));

export const name = 'gemini';
export const supportsAudio = true; // Gemini takes audio, images and PDFs directly.

const VISUAL = new Set(['image', 'pdf']);

/**
 * Note the ordering: the text prompt goes BEFORE the media, which Google's own
 * guidance says improves reading text out of an image.
 */
function toPart(a) {
  const part = { inlineData: { mimeType: a.mime, data: a.data } };
  // Fine print in a Seller Central or Sellerboard screenshot is exactly what the
  // resolution knob is for.
  if (VISUAL.has(a.kind)) part.mediaResolution = `MEDIA_RESOLUTION_${config.imageResolution}`;
  return part;
}

export async function extract({ system, text, attachments = [] }) {
  const parts = [{ text }, ...attachments.map(toPart)];

  // Screenshots and PDFs get the stronger model; plain chat stays on the cheap one.
  const hasVisual = attachments.some((a) => VISUAL.has(a.kind));
  const model = hasVisual ? config.geminiVisionModel : config.geminiModel;

  const res = await api().models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: geminiSchema,
      temperature: 0,
    },
  });

  let tasks = [];
  try {
    tasks = JSON.parse(res.text)?.tasks ?? [];
  } catch {
    throw new Error(`Gemini returned unparseable JSON: ${String(res.text).slice(0, 200)}`);
  }

  const u = res.usageMetadata || {};
  return { tasks, model, usage: { in: u.promptTokenCount ?? 0, out: u.candidatesTokenCount ?? 0 } };
}

/**
 * Transcribes a voice note. Handles Urdu, Roman Urdu, English, and — importantly
 * for this business — sentences that switch between them mid-flow.
 */
export async function transcribeAudio({ mime, data }) {
  const res = await api().models.generateContent({
    model: config.transcribeModel,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'Transcribe this voice note verbatim. The speaker may use English, Urdu, ' +
              'Roman Urdu, or switch between them mid-sentence — transcribe each part in ' +
              'the language actually spoken, using Roman (Latin) script for Urdu so it stays ' +
              'readable. Do not translate, summarise, or add commentary. If a stretch is ' +
              'inaudible write [inaudible]. Output only the transcript.',
          },
          { inlineData: { mimeType: mime, data } },
        ],
      },
    ],
    config: { temperature: 0 },
  });

  return (res.text || '').trim();
}

/** Lists models actually available on this API key. */
export async function listModels() {
  const out = [];
  for await (const m of await api().models.list()) out.push(m);
  return out;
}
