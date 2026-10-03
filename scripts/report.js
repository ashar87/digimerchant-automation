/**
 * Summarises a dry-run log so you can judge detection quality quickly.
 *
 *   npm run report                 reads dryrun.log
 *   npm run report -- other.log    reads another file
 *   npm run report -- --since 14:00
 *
 * The log is append-only across runs, so `--since` matters: old entries from a
 * previous run will otherwise be counted alongside the current one.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || 'dryrun.log';
const sinceArg = args[args.indexOf('--since') + 1];
const since = args.includes('--since') ? sinceArg : null;

if (!fs.existsSync(file)) {
  console.error(`No such log: ${file}\nRun:  npm run dry 2>&1 | tee -a dryrun.log`);
  process.exit(1);
}

const strip = (s) =>
  s
    .replace(/\x1b\[[0-9;]*m/g, '')
    // journalctl prefixes every line with "Mon DD HH:MM:SS host unit[pid]: ".
    // Drop it so the app's own timestamp is at the start, where the parser
    // expects it. Handles the default and -o short-iso formats.
    .replace(/^\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[^\s\[]+\[\d+\]:\s?/, '')
    .replace(/^\d{4}-\d{2}-\d{2}T\S+\s+\S+\s+[^\s\[]+\[\d+\]:\s?/, '');
let lines = fs.readFileSync(file, 'utf8').split('\n').map(strip);

const stamp = (l) => (l.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/) || [])[1] || null;

if (since) {
  const cut = since.includes(' ') ? since : `${(lines.map(stamp).find(Boolean) || '').slice(0, 10)} ${since}`;
  const start = lines.findIndex((l) => { const t = stamp(l); return t && t >= cut; });
  if (start > 0) lines = lines.slice(start);
}

const stamps = lines.map(stamp).filter(Boolean);
const count = (re) => lines.filter((l) => re.test(l)).length;

/* ---- tasks it would have raised ---- */
const tasks = [];
lines.forEach((l, i) => {
  const m = l.match(/\*\[([A-Z]\d+)\]\s+(.+?)\*\s*$/);
  if (!m) return;
  const meta = lines[i + 1] || '';
  const quote = (lines.slice(i, i + 6).find((x) => x.trim().startsWith('💬')) || '').replace(/^\s*💬\s*/, '');
  tasks.push({ ref: m[1], title: m[2], meta: meta.trim(), quote });
});

/* ---- token spend ---- */
let tokIn = 0, tokOut = 0;
for (const l of lines) {
  const m = l.match(/\(in (\d+) \/ out (\d+) tokens\)/);
  if (m) { tokIn += +m[1]; tokOut += +m[2]; }
}

const pad = (n) => String(n).padStart(3);
console.log(`\n\x1b[1m${file}\x1b[0m  ${stamps[0] || '?'}  →  ${stamps.at(-1) || '?'}`);
console.log('─'.repeat(64));
console.log(`  ${pad(count(/analysing \d+ message/))}  conversations analysed`);
console.log(`  ${pad(tasks.length)}  tasks it would have raised`);
console.log(`  ${pad(count(/no tasks in /))}  conversations with nothing actionable`);
console.log(`  ${pad(count(/skipping duplicate/))}  duplicates suppressed`);
console.log(`  ${pad(count(/transcribed .* voice note/))}  voice notes transcribed`);
console.log('─'.repeat(64));
const dl = count(/could not download/);
const missed = count(/MISSED a /);
const failed = count(/extraction failed/);
const retried = count(/retrying in/);
console.log(`  ${pad(dl)}  media downloads failed        ${dl ? '\x1b[33m← check these\x1b[0m' : ''}`);
console.log(`  ${pad(missed)}  messages lost entirely        ${missed ? '\x1b[31m← you were alerted\x1b[0m' : ''}`);
console.log(`  ${pad(failed)}  model calls failed outright   ${failed ? '\x1b[33m← after retries\x1b[0m' : ''}`);
console.log(`  ${pad(retried)}  retries (these recovered)`);

if (tokIn) {
  console.log('─'.repeat(64));
  console.log(`  tokens: ${tokIn.toLocaleString()} in / ${tokOut.toLocaleString()} out`);
}

if (tasks.length) {
  console.log(`\n\x1b[1mWould have asked you to approve:\x1b[0m\n`);
  for (const t of tasks) {
    console.log(`  [${t.ref}] ${t.title}`);
    if (t.meta && !t.meta.startsWith('Reply')) console.log(`        ${t.meta}`);
    if (t.quote) console.log(`        ${t.quote}`);
    console.log();
  }
}

const quiet = stamps.length ? (Date.now() - Date.parse(stamps.at(-1).replace(' ', 'T'))) / 60000 : null;
if (quiet !== null && quiet > 60) {
  console.log(`\x1b[33mNothing logged for ${Math.round(quiet / 60)}h.\x1b[0m Either the watched chats were quiet,`);
  console.log(`or the Mac slept / the process stopped. Check with:  pgrep -fl "node src/index.js"\n`);
}
