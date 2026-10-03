import crypto from 'node:crypto';
import fs from 'node:fs';

// File layout: "DMLC1" | salt(16) | iv(12) | tag(16) | ciphertext
const MAGIC = Buffer.from('DMLC1');

function key(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptFile(from, to, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(fs.readFileSync(from)), cipher.final()]);
  fs.writeFileSync(to, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]), { mode: 0o600 });
}

export function decryptFile(from, to, passphrase) {
  const buf = fs.readFileSync(from);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a landing-cost backup');
  let at = MAGIC.length;
  const salt = buf.subarray(at, (at += 16));
  const iv = buf.subarray(at, (at += 12));
  const tag = buf.subarray(at, (at += 16));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(at)), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase, or the backup is damaged');
  }
  fs.writeFileSync(to, plain, { mode: 0o600 });
}
