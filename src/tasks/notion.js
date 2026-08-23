import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { log } from '../logger.js';

let client;
const notion = () => (client ??= new Client({ auth: config.notionApiKey }));

/** The schema `npm run setup:notion` creates, and that createTask writes into. */
export const SCHEMA = {
  Task: { title: {} },
  Status: {
    select: {
      options: [
        { name: 'To do', color: 'red' },
        { name: 'In progress', color: 'yellow' },
        { name: 'Blocked', color: 'orange' },
        { name: 'Done', color: 'green' },
      ],
    },
  },
  Assignee: {
    select: {
      options: [
        { name: 'Ashar', color: 'blue' },
        { name: 'Atif', color: 'purple' },
        { name: 'Rafay', color: 'pink' },
        { name: 'Unassigned', color: 'gray' },
      ],
    },
  },
  Due: { date: {} },
  Priority: {
    select: {
      options: [
        { name: 'high', color: 'red' },
        { name: 'medium', color: 'yellow' },
        { name: 'low', color: 'gray' },
      ],
    },
  },
  Source: { select: { options: [] } },
  'Captured': { date: {} },
  'Confidence': { number: { format: 'percent' } },
  'Ref': { rich_text: {} },
};

/** Creates the task database under a page you've shared with the integration. */
export async function createDatabase(parentPageId) {
  const res = await notion().databases.create({
    parent: { type: 'page_id', page_id: parentPageId },
    icon: { type: 'emoji', emoji: '✅' },
    title: [{ type: 'text', text: { content: 'Digi Merchant Tasks' } }],
    description: [{ type: 'text', text: { content: 'Tasks captured automatically from WhatsApp and confirmed by Ashar.' } }],
    properties: SCHEMA,
  });
  return res;
}

/** Writes one approved task. Returns the Notion page URL. */
export async function createTask(candidate) {
  if (config.dryRun) {
    log.warn(`DRY_RUN: would create Notion task "${candidate.title}"`);
    return 'https://notion.so/dry-run';
  }

  const properties = {
    Task: { title: [{ text: { content: candidate.title.slice(0, 2000) } }] },
    Status: { select: { name: 'To do' } },
    Assignee: { select: { name: candidate.assignee || 'Unassigned' } },
    Priority: { select: { name: candidate.priority || 'medium' } },
    Source: { select: { name: (candidate.chat_label || candidate.chatLabel || 'WhatsApp').slice(0, 100) } },
    Captured: { date: { start: new Date().toISOString() } },
    Ref: { rich_text: [{ text: { content: candidate.ref || '' } }] },
  };

  const due = candidate.due_date || candidate.dueDate;
  if (due) properties.Due = { date: { start: due } };

  const confidence = candidate.confidence;
  if (typeof confidence === 'number') properties.Confidence = { number: confidence };

  const children = [];
  const notes = candidate.notes;
  if (notes) {
    children.push(block('paragraph', notes));
  }
  const quote = candidate.quote;
  if (quote) {
    children.push({
      object: 'block',
      type: 'quote',
      quote: { rich_text: [{ type: 'text', text: { content: quote.slice(0, 2000) } }] },
    });
  }
  children.push(block('paragraph', `Captured from WhatsApp — ${candidate.chat_label || candidate.chatLabel}`));

  const page = await notion().pages.create({
    parent: { database_id: config.notionDatabaseId },
    properties,
    children,
  });

  return page.url;
}

function block(type, content) {
  return {
    object: 'block',
    type,
    [type]: { rich_text: [{ type: 'text', text: { content: String(content).slice(0, 2000) } }] },
  };
}

/** Adds a select option if it isn't already there (e.g. a new chat as a Source). */
export async function ensureSelectOption(property, name) {
  if (config.dryRun || !name) return;
  try {
    const db = await notion().databases.retrieve({ database_id: config.notionDatabaseId });
    const prop = db.properties[property];
    if (!prop?.select) return;
    if (prop.select.options.some((o) => o.name === name)) return;
    await notion().databases.update({
      database_id: config.notionDatabaseId,
      properties: { [property]: { select: { options: [...prop.select.options, { name }] } } },
    });
    log.debug(`notion: added "${name}" to ${property}`);
  } catch (err) {
    log.warn(`notion: could not extend ${property} options:`, err.message);
  }
}
