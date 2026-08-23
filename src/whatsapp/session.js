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
