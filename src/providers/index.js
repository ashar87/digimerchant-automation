import { config } from '../config.js';
import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';

const PROVIDERS = { anthropic, gemini };

/**
 * Returns the model adapter named by LLM_PROVIDER (or an override, so
 * `npm run replay -- --provider anthropic` can A/B the two on identical input).
 */
export function getProvider(override) {
  const key = (override || config.provider || 'gemini').toLowerCase();
  const p = PROVIDERS[key];
  if (!p) throw new Error(`Unknown LLM_PROVIDER "${key}" — expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

export const providerNames = Object.keys(PROVIDERS);
