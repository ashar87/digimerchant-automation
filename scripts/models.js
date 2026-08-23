/** Lists the Gemini models actually available on your API key, so you can set a live GEMINI_MODEL. */
import { config, assertEnv } from '../src/config.js';
import { listModels } from '../src/providers/gemini.js';

assertEnv(['geminiApiKey']);

const models = await listModels();
const usable = models
  .filter((m) => (m.supportedActions || m.supportedGenerationMethods || []).includes('generateContent'))
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`\n${usable.length} model(s) available for generateContent:\n`);
for (const m of usable) {
  const id = m.name.replace(/^models\//, '');
  const marker = id === config.geminiModel ? ' \x1b[32m← current GEMINI_MODEL\x1b[0m' : '';
  console.log(`  ${id.padEnd(42)} ${m.displayName || ''}${marker}`);
}
console.log(`\nSet GEMINI_MODEL / TRANSCRIBE_MODEL in .env to one of the above.`);
console.log(`A Flash-tier model is the right choice here — this is a high-volume classifier, not a reasoning job.\n`);
