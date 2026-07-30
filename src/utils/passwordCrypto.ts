import crypto from 'crypto';

/**
 * Reversible encryption for tenant user passwords, stored ALONGSIDE the
 * one-way bcrypt hash (which remains the only thing ever used to verify a
 * login). This exists purely so the superadmin panel can display a shop's
 * current password on demand.
 *
 * Security note: unlike bcrypt, this is reversible by anyone holding
 * PASSWORD_ENCRYPTION_KEY — a compromise of that key (or the DB + key
 * together) exposes every stored password at once, not just one at a time.
 * This tradeoff was explicitly requested; keep the key out of source control
 * and rotate/remove this feature if that risk profile ever changes.
 */

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const secret = process.env.PASSWORD_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'PASSWORD_ENCRYPTION_KEY is not set. Add a 32-byte (64 hex char) key to your .env file.'
    );
  }
  const key = Buffer.from(secret, 'hex');
  if (key.length !== 32) {
    throw new Error('PASSWORD_ENCRYPTION_KEY must be 32 bytes, given as a 64-character hex string.');
  }
  return key;
}

// Output format: iv:authTag:ciphertext, all hex-encoded.
export function encryptPassword(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptPassword(payload: string): string {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('Malformed encrypted password payload.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
