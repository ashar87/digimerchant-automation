import { config } from '../config.js';
import { log } from '../logger.js';
import { getProvider } from '../providers/index.js';
import { systemPrompt, userPrompt } from './prompt.js';
import { today } from '../util/time.js';

/**
 * Sends one buffered conversation to the model and returns the task candidates.
 * Returns [] on any failure — a provider outage must never crash the listener.
 */
export async function extractTasks({ chatId, chatLabel, chatContext, isGroup, messages, people, provider, unknownAssignee }) {
  const model = getProvider(provider);
  const todayLocal = today();
  const { text, attachments } = userPrompt({ chatLabel, chatContext, isGroup, messages, today: todayLocal });

  // Drop attachments this provider can't take (Claude has no audio path).
  const usable = attachments.filter((a) => a.kind !== 'audio' || model.supportsAudio);

  try {
    const { tasks, usage, model: modelId } = await model.extract({
      system: systemPrompt({ people }),
      text,
      attachments: usable,
    });

    log.debug(
      `${model.name}/${modelId}: ${messages.length} msg(s) + ${usable.length} attachment(s) from "${chatLabel}" ` +
        `-> ${tasks.length} raw candidate(s) (in ${usage.in} / out ${usage.out} tokens)`
    );

    return tasks
      .filter((t) => t?.title && (t.confidence ?? 0) >= config.minConfidence)
      .map((t) => ({
        chatId,
        chatLabel,
        title: String(t.title).trim(),
        assignee: normaliseAssignee(t.assignee, people, unknownAssignee),
        dueDate: validDate(t.dueDate),
        priority: ['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium',
        notes: t.notes || null,
        quote: (t.quote || '').slice(0, 300) || null,
        confidence: t.confidence,
      }));
  } catch (err) {
    log.error(`${model.name} extraction failed:`, err.message);
    return [];
  }
}

/**
 * Maps whatever the model returned onto a canonical roster name from config/chats.json.
 *
 * A chat can set `unknownAssignee` to catch anyone outside the roster — used where
 * one person is accountable for a group of people who are not tracked individually.
 * That is a deterministic backstop for the same rule stated in the chat's context:
 * the prompt should already handle it, this guarantees it.
 */
function normaliseAssignee(name, people = {}, unknownAssignee = null) {
  if (!name) return null;
  const lower = String(name).trim().toLowerCase();
  if (!lower || lower === 'null' || lower === 'unassigned') return null;
  for (const [canonical, aliases] of Object.entries(people)) {
    if (canonical === '_comment') continue;
    if (canonical.toLowerCase() === lower) return canonical;
    if (Array.isArray(aliases) && aliases.some((a) => String(a).toLowerCase() === lower)) return canonical;
  }
  if (unknownAssignee) {
    log.debug(`assignee "${name}" is outside the roster -> ${unknownAssignee}`);
    return unknownAssignee;
  }
  return String(name).trim();
}

function validDate(d) {
  if (!d) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;
}
