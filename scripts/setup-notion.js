/**
 * One-time: creates the "Digi Merchant Tasks" database in Notion.
 *
 *   npm run setup:notion -- --list          show pages the integration can see
 *   npm run setup:notion -- <page-url|id>   create the database under that page
 *   npm run setup:notion                    use NOTION_PARENT_PAGE_ID from .env
 *
 * Before running:
 *   1. https://www.notion.so/my-integrations → New integration → copy the secret
 *      into NOTION_API_KEY in .env
 *   2. In Notion, open the page the board should live under, click ⋯ →
 *      Connections → add your integration
 *   3. Pass that page's URL as an argument, or put its ID in NOTION_PARENT_PAGE_ID
 */
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@notionhq/client';
import { config, ROOT, assertEnv } from '../src/config.js';
import { createDatabase } from '../src/tasks/notion.js';
import { log } from '../src/logger.js';

assertEnv(['notionApiKey']);
const notion = new Client({ auth: config.notionApiKey });

const args = process.argv.slice(2);
const wantsList = args.includes('--list');
const positional = args.find((a) => !a.startsWith('--'));

/** Accepts a full Notion URL or a bare ID, with or without dashes. */
function extractId(input) {
  if (!input) return null;
  const hex = String(input).replace(/-/g, '').match(/[0-9a-f]{32}/i);
  return hex ? hex[0] : null;
}

async function accessiblePages() {
  const res = await notion.search({ filter: { property: 'object', value: 'page' }, page_size: 100 });
  return res.results.map((r) => ({
    id: r.id,
    title: Object.values(r.properties || {}).find((p) => p.type === 'title')?.title?.[0]?.plain_text || '(untitled)',
    url: r.url,
  }));
}

async function listAndExit() {
  const pages = await accessiblePages();
  if (!pages.length) {
    log.warn('The integration cannot see any pages yet.');
    console.log('\nIn Notion: open the page you want → ⋯ (top right) → Connections → add your integration.\n');
    return;
  }
  console.log(`\nPages this integration can use as a parent:\n`);
  for (const p of pages) console.log(`  ${p.id}  ${p.title}`);
  console.log(`\nRun:  npm run setup:notion -- <paste the page URL>\n`);
}

if (wantsList) {
  await listAndExit();
  process.exit(0);
}

const parentId = extractId(positional) || extractId(config.notionParentPageId);

if (!parentId) {
  log.error('No parent page given.');
  console.log('\nPass the page URL:  npm run setup:notion -- https://www.notion.so/Your-Page-abc123…');
  console.log('or see what is available:  npm run setup:notion -- --list\n');
  process.exit(1);
}

let db;
try {
  db = await createDatabase(parentId);
} catch (err) {
  const body = safeBody(err);
  log.error(`Notion rejected the request: ${body?.message || err.message}`);

  if (body?.code === 'object_not_found') {
    console.log('\nThat ID is not a page this integration can reach. Two usual causes:');
    console.log('  1. The page has not been shared with the integration');
    console.log('     → in Notion: open the page → ⋯ → Connections → add your integration');
    console.log('  2. The ID is not a page ID at all (an integration ID is a common mix-up)');
    console.log('\nWhat the integration CAN see right now:');
    try {
      const pages = await accessiblePages();
      if (!pages.length) console.log('  (nothing — no page has been shared with it yet)');
      else for (const p of pages) console.log(`  ${p.id}  ${p.title}`);
    } catch { /* listing is best-effort */ }
    console.log();
  }
  process.exit(1);
}

log.ok('Created Notion database');
console.log(`  Title: Digi Merchant Tasks`);
console.log(`  URL:   ${db.url}`);
console.log(`  ID:    ${db.id}`);

const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  let env = fs.readFileSync(envPath, 'utf8');
  env = /^NOTION_DATABASE_ID=.*$/m.test(env)
    ? env.replace(/^NOTION_DATABASE_ID=.*$/m, `NOTION_DATABASE_ID=${db.id}`)
    : `${env.trimEnd()}\nNOTION_DATABASE_ID=${db.id}\n`;
  fs.writeFileSync(envPath, env);
  log.ok('Wrote NOTION_DATABASE_ID into .env');
} else {
  log.warn('No .env found. Add this line yourself:');
  console.log(`NOTION_DATABASE_ID=${db.id}`);
}

function safeBody(err) {
  try { return JSON.parse(err.body); } catch { return null; }
}
