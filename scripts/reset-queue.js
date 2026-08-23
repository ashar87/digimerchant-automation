/**
 * Clears candidates raised during a dry run so your first live day starts clean.
 *
 *   npm run reset:queue           clear pending candidates + duplicate fingerprints
 *   npm run reset:queue -- --all  also forget which messages have been seen
 *
 * Why this exists: a dry run still writes candidates to the local store and
 * records their duplicate fingerprints. Go live without clearing them and you get
 * two surprises — a backlog of cards for conversations you already reviewed, and
 * 14 days of silent duplicate-suppression on everything the dry run saw.
 *
 * Voice-note transcripts are always kept. They cost money to produce and are
 * keyed by message id, so they stay valid.
 */
import db from '../src/store/db.js';
import { log } from '../src/logger.js';

const all = process.argv.includes('--all');

const pending = db.prepare("SELECT COUNT(*) n FROM candidates WHERE status = 'pending'").get().n;
const decided = db.prepare("SELECT COUNT(*) n FROM candidates WHERE status != 'pending'").get().n;
const prints = db.prepare('SELECT COUNT(*) n FROM fingerprints').get().n;
const seen = db.prepare('SELECT COUNT(*) n FROM seen_messages').get().n;
const scripts = db.prepare('SELECT COUNT(*) n FROM transcripts').get().n;

console.log(`\n  pending candidates : ${pending}`);
console.log(`  decided candidates : ${decided}`);
console.log(`  duplicate prints   : ${prints}`);
console.log(`  seen messages      : ${seen}`);
console.log(`  cached transcripts : ${scripts}  (always kept)\n`);

db.prepare('DELETE FROM candidates').run();
db.prepare('DELETE FROM fingerprints').run();
db.prepare("DELETE FROM meta WHERE key = 'ref_counter'").run();
if (all) db.prepare('DELETE FROM seen_messages').run();

log.ok(`Cleared ${pending + decided} candidate(s), ${prints} fingerprint(s), and reset task refs to A1.`);
if (all) log.ok(`Also cleared ${seen} seen-message record(s).`);
console.log(`\nReady for a clean run. Set DRY_RUN=false in .env when you want it live.\n`);
