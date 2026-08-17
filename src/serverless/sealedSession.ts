/**
 * Sealed sessions: the `sealed` half of the `SessionResolver` port, for runtimes that have nowhere
 * to keep process state. The credential travels inside the token, encrypted, instead of being kept
 * on a server that the next request might not reach.
 *
 * Deliberately built on `globalThis.crypto.subtle` rather than `node:crypto`, which is the mirror
 * image of the decision in `services/auth/sessionCrypto.ts`: that module is synchronous because the
 * repository contract Electron depends on is synchronous, and this one is async because Workers
 * only offer Web Crypto. The envelope discipline is the same in both — one key per purpose, and the
 * purpose bound into the ciphertext — but the serialisation differs because the constraints do: a
 * file can hold pretty-printed JSON, a token has to survive a URL.
 *
 * Nothing here imports the Koa app, the config barrel or anything reaching `node:fs`.
 */

/** HKDF `info` values. Different `info` is what makes the three keys cryptographically unrelated. */
export const SEALED_AUTH_PURPOSE = 'qq-music-api/v1/sealed-auth';
export const SEALED_QR_PURPOSE = 'qq-music-api/v1/sealed-qr';
export const DERIVED_DEVICE_PURPOSE = 'qq-music-api/v1/derived-device';

const TOKEN_PREFIX = 'qq1';
const KEY_BITS = 256;
const IV_BYTES = 12;
const KID_BYTES = 6;

/**
 * One character per purpose in the wire format. Kept separate from the `info` strings so the token
 * stays short while the key derivation keeps its self-describing, collision-proof names.
 */
const PURPOSE_TAGS: Record<string, string> = {
  [SEALED_AUTH_PURPOSE]: 'a',
  [SEALED_QR_PURPOSE]: 'q',
};

export class SealedSessionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SealedSessionError';
  }
}

/**
 * `current` signs and verifies; `previous` only verifies. Rotating without setting `previous` logs
 * everyone out at once — a deliberate, documented behaviour rather than an accident, because the
 * alternative is a secret that can never be retired.
 */
export interface SealedSecrets {
  current: string;
  previous?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// `Uint8Array<ArrayBuffer>` rather than the default `Uint8Array<ArrayBufferLike>` throughout:
// Web Crypto's `BufferSource` excludes `SharedArrayBuffer`, so the narrower buffer type is what
// lets these values be passed straight to `subtle` without a cast.
const toBase64Url = (bytes: Uint8Array<ArrayBuffer>): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string, field: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new SealedSessionError(`Token field ${field} is not base64url`);
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new SealedSessionError(`Token field ${field} is not base64url`);
  }
};

const importSecret = (secret: string): Promise<CryptoKey> =>
  globalThis.crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveBits']);

/**
 * HKDF-SHA256 with an empty salt. The salt is omitted rather than forgotten: the input keying
 * material is a deployment secret that is already required to be high-entropy, and a per-token salt
 * cannot be reconstructed at verification time without spending bytes in the token to carry it.
 * Separation comes from `info`, which is exactly what `info` is for.
 */
export const deriveBits = async (
  secret: string,
  purpose: string,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  if (!secret) throw new SealedSessionError('A session secret is required');
  const derived = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode(purpose),
    },
    await importSecret(secret),
    bytes * 8,
  );
  return new Uint8Array(derived);
};

const deriveAesKey = async (secret: string, purpose: string): Promise<CryptoKey> => {
  const bits = await deriveBits(secret, purpose, KEY_BITS / 8);
  return globalThis.crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

/**
 * A short, non-secret label for "which secret sealed this". Derived through its own `info`, so it
 * reveals nothing about the encryption keys, and it is what lets a rotated deployment tell a token
 * it can still open from one it never could.
 */
export const deriveKeyId = async (secret: string): Promise<string> =>
  toBase64Url(await deriveBits(secret, `${DERIVED_DEVICE_PURPOSE}/kid`, KID_BYTES));

const purposeTagOf = (purpose: string): string => {
  const tag = PURPOSE_TAGS[purpose];
  if (!tag) throw new SealedSessionError(`Unknown sealed purpose: ${purpose}`);
  return tag;
};

/** AAD binds both the purpose and the key id, so neither can be swapped without failing the tag. */
const additionalData = (purpose: string, kid: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(`${TOKEN_PREFIX}:${purpose}:${kid}`);

export const sealToken = async (
  payload: unknown,
  purpose: string,
  secret: string,
): Promise<string> => {
  const tag = purposeTagOf(purpose);
  const kid = await deriveKeyId(secret);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(purpose, kid) },
    await deriveAesKey(secret, purpose),
    encoder.encode(JSON.stringify(payload)),
  );
  return [TOKEN_PREFIX, tag, kid, toBase64Url(iv), toBase64Url(new Uint8Array(sealed))].join('.');
};

const openWithSecret = async (
  parts: { tag: string; kid: string; iv: Uint8Array<ArrayBuffer>; ct: Uint8Array<ArrayBuffer> },
  purpose: string,
  secret: string,
): Promise<unknown> => {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parts.iv, additionalData: additionalData(purpose, parts.kid) },
      await deriveAesKey(secret, purpose),
      parts.ct,
    );
  } catch {
    // One message for a wrong key, a wrong purpose and a flipped byte alike. Whoever is holding
    // the token learns only that it did not open.
    throw new SealedSessionError('Token failed authentication');
  }
  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new SealedSessionError('Sealed payload is not valid JSON');
  }
};

export const openToken = async (
  token: string,
  purpose: string,
  secrets: SealedSecrets,
): Promise<unknown> => {
  const expectedTag = purposeTagOf(purpose);
  const segments = token.split('.');
  if (segments.length !== 5 || segments[0] !== TOKEN_PREFIX)
    throw new SealedSessionError('Token is not a sealed session');
  const [, tag, kid, rawIv, rawCt] = segments;
  // Checked before any key work: a QR token presented as an auth token is a shape error, not a
  // cryptographic one, and saying so early keeps the expensive path for real candidates.
  if (tag !== expectedTag) throw new SealedSessionError('Token was sealed for another purpose');

  const iv = fromBase64Url(rawIv, 'iv');
  if (iv.length !== IV_BYTES) throw new SealedSessionError('Token field iv has an unusable length');
  const parts = { tag, kid, iv, ct: fromBase64Url(rawCt, 'ct') };

  // Only the secret whose key id matches is tried. Without this a rotated deployment would pay
  // two full derivations on every request, and a token sealed by a secret this deployment has
  // retired would be indistinguishable from one it never issued.
  const candidates = [secrets.current, secrets.previous].filter(
    (secret): secret is string => typeof secret === 'string' && secret.length > 0,
  );
  for (const secret of candidates) {
    if ((await deriveKeyId(secret)) !== kid) continue;
    return openWithSecret(parts, purpose, secret);
  }
  throw new SealedSessionError('Token was sealed by an unknown key');
};
