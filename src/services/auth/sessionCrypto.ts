import crypto from 'node:crypto';

/**
 * Minimal authenticated-encryption core for server-side session state. It offers exactly three
 * properties and nothing more: a key derived from one deployment secret, AES-256-GCM, and a
 * purpose string bound into the ciphertext so state written for one use can never be opened as
 * another.
 *
 * Synchronous on purpose. `AuthSessionRepository` is a synchronous contract — Electron's
 * `safeStorage` is synchronous at that boundary and the login service persists inside
 * non-async code paths — so the file repository cannot await anything. `node:crypto` covers
 * this with zero new dependencies. A runtime without `node:crypto` should implement the same
 * envelope format on Web Crypto rather than turn this module async, which would change the
 * repository contract that desktop hosts already depend on.
 */

const ENVELOPE_VERSION = 1;
const CIPHER = 'aes-256-gcm';
const DIGEST = 'sha256';
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The HKDF `info` and the GCM additional data, in one value so they can never drift apart.
 * Each consumer owns its own constant and never borrows another's: this is what keeps a
 * persisted session file and a future sealed token from being interchangeable even when both
 * are derived from the same `QQ_SESSION_SECRET`.
 */
export const AUTH_SESSION_STORE_PURPOSE = 'qq-music-api/v1/auth-session-store';

export class SessionCryptoError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SessionCryptoError';
  }
}

interface SessionEnvelope {
  v: number;
  alg: string;
  salt: string;
  iv: string;
  ct: string;
}

const deriveKey = (secret: string, salt: Buffer, purpose: string): Buffer =>
  Buffer.from(crypto.hkdfSync(DIGEST, secret, salt, purpose, KEY_BYTES));

/**
 * Base64 is lenient about junk, so the byte length is the real check: a truncated or hand-edited
 * field must be rejected before it reaches the cipher rather than surfacing as an opaque
 * decryption failure.
 */
const readBytes = (value: unknown, field: string, minimum: number, exact = true): Buffer => {
  if (typeof value !== 'string') throw new SessionCryptoError(`Envelope field ${field} is missing`);
  const bytes = Buffer.from(value, 'base64');
  const valid = exact ? bytes.length === minimum : bytes.length >= minimum;
  if (!valid) throw new SessionCryptoError(`Envelope field ${field} has an unusable length`);
  return bytes;
};

export const sealJson = (value: unknown, secret: string, purpose: string): string => {
  if (!secret) throw new SessionCryptoError('A session secret is required to seal state');
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, deriveKey(secret, salt, purpose), iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const envelope: SessionEnvelope = {
    v: ENVELOPE_VERSION,
    alg: CIPHER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: sealed.toString('base64'),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
};

export const openJson = (serialized: string, secret: string, purpose: string): unknown => {
  if (!secret) throw new SessionCryptoError('A session secret is required to open state');

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new SessionCryptoError('State is not a readable envelope');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new SessionCryptoError('State is not a readable envelope');

  const envelope = parsed as Partial<SessionEnvelope>;
  if (envelope.v !== ENVELOPE_VERSION || envelope.alg !== CIPHER)
    throw new SessionCryptoError('State was written by an unsupported envelope version');

  const salt = readBytes(envelope.salt, 'salt', SALT_BYTES);
  const iv = readBytes(envelope.iv, 'iv', IV_BYTES);
  // The tag travels appended to the ciphertext, so anything shorter than one tag is truncated.
  const sealed = readBytes(envelope.ct, 'ct', TAG_BYTES, false);

  const decipher = crypto.createDecipheriv(CIPHER, deriveKey(secret, salt, purpose), iv);
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));

  let plaintext: string;
  try {
    plaintext =
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES), undefined, 'utf8') +
      decipher.final('utf8');
  } catch {
    // One message for every authentication failure on purpose: a wrong secret, a different
    // purpose and a tampered byte are the same answer to whoever is holding the file.
    throw new SessionCryptoError('State failed authentication');
  }

  try {
    return JSON.parse(plaintext);
  } catch {
    throw new SessionCryptoError('Decrypted state is not valid JSON');
  }
};
