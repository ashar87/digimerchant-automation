import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { geminiSchema } from './schema.js';
import { withRetry } from './retry.js';
import { noteUsage, usageFrom } from '../ai/usage.js';

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
  // The per-part setting is an object ({ level }); a bare enum string is rejected with a 400.
  if (VISUAL.has(a.kind)) part.mediaResolution = { level: `MEDIA_RESOLUTION_${config.imageResolution}` };
  return part;
}

export async function extract({ system, text, attachments = [], label = null }) {
  const parts = [{ text }, ...attachments.map(toPart)];

  // Screenshots and PDFs get the stronger model; plain chat stays on the cheap one.
  const hasVisual = attachments.some((a) => VISUAL.has(a.kind));
  const model = hasVisual ? config.geminiVisionModel : config.geminiModel;

  const res = await withRetry(() => api().models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: geminiSchema,
    },
  }), { label: `gemini/${model}` });

  let tasks = [];
  try {
    tasks = JSON.parse(res.text)?.tasks ?? [];
  } catch {
    throw new Error(`Gemini returned unparseable JSON: ${String(res.text).slice(0, 200)}`);
  }

  const usage = usageFrom(res);
  noteUsage({ job: 'tasks', detail: label, model, ...usage });
  return { tasks, model, usage: { in: usage.input, out: usage.output + usage.thinking } };
}

/**
 * Reads a document into JSON matching `schema`. Used for supplier invoices,
 * always on the vision model. (Gemini 3.8 dropped the sampling settings such as
 * temperature; the JSON schema is what keeps the output consistent.)
 */
export async function readJson({ system, text, attachments = [], schema, job = 'document', label = null, model = config.geminiVisionModel }) {
  const res = await withRetry(() => api().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text }, ...attachments.map(toPart)] }],
    config: { systemInstruction: system, responseMimeType: 'application/json', responseSchema: schema },
  }), { label: `gemini/${model}` });
  noteUsage({ job, detail: label, model, ...usageFrom(res) });
  try {
    return { data: JSON.parse(res.text), model };
  } catch {
    throw new Error(`Gemini returned unparseable JSON: ${String(res.text).slice(0, 200)}`);
  }
}

/**
 * Transcribes a voice note. Handles Urdu, Roman Urdu, English, and — importantly
 * for this business — sentences that switch between them mid-flow.
 */
export async function transcribeAudio({ mime, data, label = null }) {
  const res = await withRetry(() => api().models.generateContent({
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
  }), { label: `transcribe/${config.transcribeModel}` });
  noteUsage({ job: 'transcribe', detail: label, model: config.transcribeModel, ...usageFrom(res) });

  return (res.text || '').trim();
}

/** Lists models actually available on this API key. */
export async function listModels() {
  const out = [];
  for await (const m of await api().models.list()) out.push(m);
  return out;
}
