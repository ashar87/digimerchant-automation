import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { anthropicTool } from './schema.js';

let client;
const api = () => (client ??= new Anthropic({ apiKey: config.anthropicApiKey }));

export const name = 'anthropic';
export const supportsAudio = false; // Claude takes text, images and PDFs — not audio.

/** Attachment -> Anthropic content block. Unsupported kinds are dropped. */
function toBlock(a) {
  if (a.kind === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } };
  }
  if (a.kind === 'pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } };
  }
  return null;
}

export async function extract({ system, text, attachments = [] }) {
  const content = [{ type: 'text', text }];
  for (const a of attachments) {
    const block = toBlock(a);
    if (block) content.push(block);
  }

  const hasVisual = attachments.some((a) => a.kind === 'image' || a.kind === 'pdf');
  const model = hasVisual ? config.anthropicVisionModel : config.anthropicModel;

  const res = await api().messages.create({
    model,
    max_tokens: 2000,
    system,
    tools: [anthropicTool],
    tool_choice: { type: 'tool', name: anthropicTool.name },
    messages: [{ role: 'user', content }],
  });

  const block = res.content.find((b) => b.type === 'tool_use');
  return {
    tasks: block?.input?.tasks ?? [],
    model,
    usage: { in: res.usage.input_tokens, out: res.usage.output_tokens },
  };
}
