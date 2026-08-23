/**
 * One-time: creates the "Digi Merchant Tasks" database in Notion.
 *
 * Before running:
 *   1. https://www.notion.so/my-integrations → New integration → copy the secret
 *      into NOTION_API_KEY in .env
 *   2. In Notion, open (or create) the page you want the task board to live under,
 *      click ⋯ → Connections → add your integration
 *   3. Copy that page's ID from its URL into NOTION_PARENT_PAGE_ID in .env
 *      (the 32-char hex string at the end of the URL)
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT, assertEnv } from '../src/config.js';
import { createDatabase } from '../src/tasks/notion.js';
import { log } from '../src/logger.js';

assertEnv(['notionApiKey', 'notionParentPageId']);

const db = await createDatabase(config.notionParentPageId.replace(/-/g, ''));

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
  log.ok('Wrote NOTION_DATABASE_ID into .env — you are ready to run `npm start`');
} else {
  log.warn('No .env found. Add this line yourself:');
  console.log(`NOTION_DATABASE_ID=${db.id}`);
}
