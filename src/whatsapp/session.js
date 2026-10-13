import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

/**
 * Chromium guards a profile with SingletonLock, a symlink pointing at
 * "<hostname>-<pid>". If the browser dies without cleaning up — a crash, a kill -9,
 * a power cut — the lock survives, Chromium refuses to reuse the profile, and
 * whatsapp-web.js quietly starts logged out and asks for a QR code again.
 *
 * So: if the PID in the lock is no longer alive, the lock is stale and safe to clear.
 * If the PID IS alive, we leave it well alone — another instance is genuinely running.
 */
export function clearStaleChromeLocks(sessionPath) {
  const profile = path.join(sessionPath, 'session');
  const lock = path.join(profile, 'SingletonLock');

  let target;
  try {
    target = fs.readlinkSync(lock);
  } catch {
    return false; // no lock, or not a symlink — nothing to do
  }

  const pid = Number(String(target).split('-').pop());
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
    log.warn(`another browser is using ${profile} (pid ${pid}) — leaving its lock alone`);
    return false;
  }

  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fs.rmSync(path.join(profile, name), { force: true });
  }
  log.info(`cleared a stale Chromium lock (pid ${pid} is gone) — reusing the saved session`);
  return true;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 tests existence without touching the process
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but owned by someone else
  }
}

/**
 * WhatsApp Web's own offline copy of its app (Service Worker cache, HTTP cache,
 * compiled code). While it runs, WhatsApp Web quietly downloads its newest build
 * into these, and the next start uses that instead of a pinned version, which
 * defeats the pin. So when a version is pinned, they're cleared before each start.
 * The login lives elsewhere in the profile (IndexedDB, Local Storage) and is kept.
 */
export const WEB_APP_CACHES = ['Service Worker', 'Cache', 'Code Cache'];

export function clearWebAppCache(sessionPath) {
  const profile = path.join(sessionPath, 'session', 'Default');
  const cleared = [];
  for (const dir of WEB_APP_CACHES) {
    const p = path.join(profile, dir);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      cleared.push(dir);
    }
  }
  return cleared;
}

/**
 * Clearing the cached app on every start made WhatsApp Web reinstall it and
 * reload mid-start, after which "synced" had already happened and the library
 * never became ready. So it's now cleared only when asked: a stuck start that
 * found WhatsApp Web on another build than the pinned one leaves this flag.
 */
const FLAG = '.clear-app-cache';
export const requestAppCacheClear = (sessionPath) => fs.writeFileSync(path.join(sessionPath, FLAG), new Date().toISOString());
export function clearAppCacheIfRequested(sessionPath) {
  const flag = path.join(sessionPath, FLAG);
  if (!fs.existsSync(flag)) return [];
  const cleared = clearWebAppCache(sessionPath);
  fs.rmSync(flag, { force: true });
  return cleared;
}
