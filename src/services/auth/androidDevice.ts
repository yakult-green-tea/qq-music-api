import { type Dictionary, identifierOf } from './values';

// Synthetic Android device material and the QIMEI bootstrap request construction.
//
// Runtime-neutral by contract, and literally so: this module imports no platform module at all,
// `node:crypto` included. A Vercel Edge Function refuses to deploy a bundle that imports
// `node:crypto` at all — `nodejs_compat`-style opt-ins are a Cloudflare Workers thing, not a
// Vercel one — so unlike the M0-era assumption ("Workers can have it, Vercel wasn't checked"),
// there is no platform flag to lean on here. Every operation below (MD5, the QIMEI RSA/AES
// envelope, uniform random integers) is built on `globalThis.crypto`, which Node ≥20, Electron,
// Cloudflare Workers and the Vercel Edge Runtime all implement identically as the Web Crypto API
// — so this one implementation is what every runtime actually runs, not a serverless substitute
// for a Node original. `md5` and the RSAES-PKCS1-v1_5 encryption in `buildQimeiRequest` are
// hand-rolled because Web Crypto has neither: `subtle.digest` only offers the SHA family, and
// `subtle` only offers RSA-OAEP / RSASSA-PKCS1-v1_5 *signing*, not the PKCS1-v1_5 *encryption*
// padding this bootstrap protocol requires. Both are verified byte-for-byte against `node:crypto`
// in `tests/services.qimei-crypto.test.ts` — the RSA step via an encrypt/decrypt round trip
// through a throwaway keypair, since there is no private key for the real QIMEI bootstrap key to
// decrypt with. AES-128-CBC has a native Web Crypto primitive (`subtle.encrypt`), so that one is
// not hand-rolled; the only reason it forces `buildQimeiRequest` to become `async` is that
// `subtle.encrypt` is Promise-based where `node:crypto`'s cipher API was synchronous. Persistence
// (`node:fs`) lives in `deviceContext.ts` and the MQTT transport lives in `qrLogin.ts`, so neither
// reaches a serverless bundle through this file either.
//
// Values here identify a synthetic device, never a user: no musickey, MQTT token or QR key is
// ever stored, logged or returned.

export const QIMEI_URL = 'https://api.tencentmusic.com/tme/trpc/proxy';
// Public Android client protocol constants, not user credentials.
const QIMEI_SECRET = 'ZdJqM15EeO2zWc08';
const QIMEI_APP_KEY = '0AND0HD6FE4HY80F';
export const CHANNEL_ID = '10003505';
const PACKAGE_ID = 'com.tencent.qqmusic';

export interface AndroidDevice {
  display: string;
  product: string;
  device: string;
  board: string;
  model: string;
  fingerprint: string;
  procVersion: string;
  imei: string;
  brand: string;
  androidId: string;
  openUdid: string;
  osRelease: string;
  sdk: number;
  qimei?: string;
  qimei36?: string;
  qimeiSavedAt?: number;
  sessionUid?: string;
  sessionSid?: string;
  sessionVkey?: unknown;
  [key: string]: unknown;
}

/**
 * The credential fields the Android comm block reads. `QqCredential` satisfies this shape; the
 * narrow declaration keeps the device module free of the login service's import graph.
 */
export interface AndroidCommCredential {
  musicid: string | number;
  musickey: string;
  loginType: number;
  str_musicid?: unknown;
}

// ---- MD5 (RFC 1321) ---------------------------------------------------------------------------
// Web Crypto's `subtle.digest` does not offer MD5 (only the SHA family), and the QIMEI protocol's
// two `sign` fields are MD5 hex digests of concatenated strings — the same input `hash.update()`
// called once per argument used to produce. Verified byte-for-byte against `node:crypto` across a
// range of inputs, including ones long enough to span multiple 64-byte blocks, in
// `tests/services.qimei-crypto.test.ts`.

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_CONSTANTS = Int32Array.from({ length: 64 }, (_, index) =>
  Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32),
);

const rotateLeft32 = (value: number, bits: number): number =>
  (value << bits) | (value >>> (32 - bits));

const md5Digest = (bytes: Uint8Array): string => {
  const bitLength = BigInt(bytes.length) * 8n;
  // Zero-pad after the mandatory `0x80` byte until the length is 56 (mod 64), leaving exactly 8
  // bytes for the trailing bit-length field to land on a 64-byte block boundary.
  const paddingLength = (56 - ((bytes.length + 1) % 64) + 64) % 64;
  const total = bytes.length + 1 + paddingLength + 8;
  const message = new Uint8Array(total);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setBigUint64(total - 8, bitLength, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunkStart = 0; chunkStart < total; chunkStart += 64) {
    const words = new Int32Array(16);
    for (let index = 0; index < 16; index += 1)
      words[index] = view.getInt32(chunkStart + index * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      f = (f + a + MD5_CONSTANTS[index] + words[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft32(f, MD5_SHIFTS[index])) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setInt32(0, a0, true);
  digestView.setInt32(4, b0, true);
  digestView.setInt32(8, c0, true);
  digestView.setInt32(12, d0, true);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const md5 = (...values: string[]): string =>
  md5Digest(new TextEncoder().encode(values.join('')));

// ---- Uniform randomness -------------------------------------------------------------------------
// `getRandomValues` is synchronous and identical across every runtime this package targets, unlike
// `node:crypto`'s `randomBytes`/`randomInt`. Rejection sampling matches what `crypto.randomInt`
// does internally, so `randomInt` stays free of the modulo bias a plain `% maxExclusive` would add.

const randomInt = (maxExclusive: number): number => {
  if (maxExclusive <= 1) return 0;
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  let value: number;
  do {
    value = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  } while (value >= limit);
  return value % maxExclusive;
};

export const randomHex = (length: number): string =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2))))
    .toString('hex')
    .slice(0, length);

export const randomDigits = (length: number): string => {
  let value = '';
  for (let index = 0; index < length; index += 1) value += randomInt(10);
  return value;
};

const randomImei = (): string => {
  const digits = randomDigits(14).split('').map(Number);
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits[index];
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  digits.push((10 - (sum % 10)) % 10);
  return digits.join('');
};

export const createAndroidDevice = (): AndroidDevice => ({
  display: `QMAPI.${randomDigits(6)}.001`,
  product: 'iarim',
  device: 'sagit',
  board: 'eomam',
  model: 'MI 6',
  fingerprint: `xiaomi/iarim/sagit:10/eomam.200122.001/${randomDigits(7)}:user/release-keys`,
  procVersion: `Linux 5.4.0-54-generic-${randomHex(8)} (android-build@google.com)`,
  imei: randomImei(),
  brand: 'Xiaomi',
  androidId: randomHex(16),
  openUdid: randomHex(32),
  osRelease: '10',
  sdk: 29,
});

const REQUIRED_TEXT_FIELDS = [
  'display',
  'product',
  'device',
  'board',
  'model',
  'fingerprint',
  'procVersion',
  'imei',
  'brand',
  'androidId',
  'openUdid',
  'osRelease',
] as const;

const OPTIONAL_TEXT_FIELDS = ['qimei', 'qimei36', 'sessionUid', 'sessionSid'] as const;

/** Rejects a truncated or hand-edited state file so a bad shape never reaches the protocol. */
export const isAndroidDevice = (value: unknown): value is AndroidDevice => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isFinite(candidate.sdk)) return false;
  if (candidate.qimeiSavedAt !== undefined && !Number.isFinite(candidate.qimeiSavedAt))
    return false;
  const hasText = (key: string): boolean =>
    typeof candidate[key] === 'string' && (candidate[key] as string).length > 0;
  if (!REQUIRED_TEXT_FIELDS.every(hasText)) return false;
  return OPTIONAL_TEXT_FIELDS.every((key) => candidate[key] === undefined || hasText(key));
};

/**
 * Safe log/diagnostic shape: presence and shape only, never an identifier value.
 */
export const describeDeviceContext = (device: AndroidDevice | null): Record<string, unknown> => ({
  hasDevice: Boolean(device),
  hasQimei: Boolean(device?.qimei && device?.qimei36),
  qimeiAgeMs:
    device?.qimeiSavedAt === undefined ? undefined : Math.max(0, Date.now() - device.qimeiSavedAt),
  hasSession: Boolean(device?.sessionUid && device?.sessionSid),
});

const randomBeaconId = (now = new Date()): string => {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  const first = randomDigits(6);
  const second = randomDigits(9);
  const dated = new Set([1, 2, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38]);
  const fields: string[] = [];
  for (let key = 1; key <= 40; key += 1) {
    if (dated.has(key)) fields.push(`k${key}:${month}${first}.${second}`);
    else if (key === 3) fields.push('k3:0000000000000000');
    else if (key === 4) fields.push(`k4:${randomHex(16).replaceAll('0', '1')}`);
    else fields.push(`k${key}:${randomInt(10000)}`);
  }
  return `${fields.join(';')};`;
};

const buildQimeiPayload = (device: AndroidDevice, now = new Date()): Dictionary => {
  const uptime = new Date(now.getTime() - randomInt(14401) * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const reserved = {
    harmony: '0',
    clone: '0',
    containe: '',
    oz: 'UhYmelwouA+V2nPWbOvLTgN2/m8jwGB+yUB5v9tysQg=',
    oo: 'Xecjt+9S1+f8Pz2VLSxgpw==',
    kelong: '0',
    uptimes: uptime,
    multiUser: '0',
    bod: device.brand,
    dv: device.device,
    firstLevel: '',
    manufact: device.brand,
    name: device.model,
    host: 'se.infra',
    kernel: device.procVersion,
  };
  return {
    androidId: device.androidId,
    platformId: 1,
    appKey: QIMEI_APP_KEY,
    appVersion: '14.9.0.8',
    beaconIdSrc: randomBeaconId(now),
    brand: device.brand,
    channelId: CHANNEL_ID,
    cid: '',
    imei: device.imei,
    imsi: '',
    mac: '',
    model: device.model,
    networkType: 'unknown',
    oaid: '',
    osVersion: `Android ${device.osRelease},level ${device.sdk}`,
    qimei: '',
    qimei36: '',
    sdkVersion: '1.2.13.6',
    targetSdkVersion: '33',
    audit: '',
    userId: '{}',
    packageId: PACKAGE_ID,
    deviceType: 'Phone',
    sdkName: '',
    reserved: JSON.stringify(reserved),
  };
};

// ---- QIMEI bootstrap envelope: RSA(PKCS1v1.5) key wrap + AES-128-CBC payload -------------------
// Tencent's bootstrap public key (a fixed constant, not a per-device or per-request value):
//   -----BEGIN PUBLIC KEY-----
//   MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEIxgwoutfwoJxcGQeedgP7FG9qaIuS0qzfR8gWkrkTZKM2iWHn2ajQpBR
//   ZjMSoSf6+KJGvar2ORhBfpDXyVtZCKpqLQ+FLkpncClKVIrBwv6PHyUvuCb0rIarmgDnzkfQAqVufEtR64iazGDKatvJ9y6B
//   9NMbHddGSAUmRTCrHQIDAQAB
//   -----END PUBLIC KEY-----
// Its modulus/exponent are pre-extracted once, offline, rather than parsed from PEM/DER at runtime
// — one less thing this module needs a parser for. Re-derive them with
// `openssl rsa -pubin -in key.pem -noout -modulus` / `-text` if this key ever needs to change.
const QIMEI_RSA_MODULUS_HEX =
  'c4231830a2eb5fc2827170641e79d80fec51bda9a22e4b4ab37d1f205a4ae44d928cda25879f66a3429051663312a12' +
  '7faf8a246bdaaf63918417e90d7c95b5908aa6a2d0f852e4a6770294a548ac1c2fe8f1f252fb826f4ac86ab9a00e7ce4' +
  '7d002a56e7c4b51eb889acc60ca6adbc9f72e81f4d31b1dd7464805264530ab1d';
const QIMEI_RSA_EXPONENT = 65537n;

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
};

/**
 * RSAES-PKCS1-v1_5 encryption (RFC 8017 §7.2.1), generic over the key so it can be verified
 * against an arbitrary keypair. Neither Web Crypto (`subtle.encrypt` only offers RSA-OAEP) nor a
 * Node-only `crypto.publicEncrypt` call can produce this padding on every target runtime, so it is
 * implemented directly over `BigInt` modular exponentiation. Verified against
 * `crypto.publicEncrypt`/`privateDecrypt` round trips through a throwaway keypair in
 * `tests/services.qimei-crypto.test.ts` — there is no private key for the real QIMEI bootstrap key
 * to check a *specific* ciphertext against, since PKCS1v1.5 padding is randomised per call anyway.
 */
export const rsaesPkcs1Encrypt = (
  message: Uint8Array,
  modulusHex: string,
  exponent: bigint,
): Buffer => {
  const modulus = BigInt(`0x${modulusHex}`);
  const k = modulusHex.length / 2;
  if (message.length > k - 11) throw new Error('RSAES-PKCS1-v1_5 payload too long for this key');

  const paddingLength = k - message.length - 3;
  const padding = new Uint8Array(paddingLength);
  // PKCS#1 v1.5 padding bytes must be nonzero; resample any zero bytes a batch happens to draw.
  let filled = 0;
  while (filled < paddingLength) {
    const batch = globalThis.crypto.getRandomValues(new Uint8Array(paddingLength - filled));
    for (const byte of batch) if (byte !== 0) padding[filled++] = byte;
  }

  const block = new Uint8Array(k);
  block[1] = 0x02;
  block.set(padding, 2);
  block[2 + paddingLength] = 0x00;
  block.set(message, 3 + paddingLength);

  const encoded = modPow(BigInt(`0x${Buffer.from(block).toString('hex')}`), exponent, modulus);
  let hex = encoded.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const cipherBytes = Buffer.from(hex, 'hex');
  return cipherBytes.length === k
    ? cipherBytes
    : Buffer.concat([Buffer.alloc(k - cipherBytes.length), cipherBytes]);
};

const rsaEncryptQimeiKey = (message: Uint8Array): Buffer =>
  rsaesPkcs1Encrypt(message, QIMEI_RSA_MODULUS_HEX, QIMEI_RSA_EXPONENT);

/**
 * AES-CBC has a native Web Crypto primitive, unlike MD5 and RSAES-PKCS1-v1_5 above, so this one is
 * not hand-rolled — just adapted to `subtle`'s Promise-based shape. Matches `node:crypto`'s
 * `createCipheriv('aes-128-cbc', key, iv)` byte-for-byte, PKCS7 padding included (also verified in
 * `tests/services.qimei-crypto.test.ts`).
 */
export const aesCbcEncrypt = async (
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Buffer> => {
  // `Uint8Array.from` rather than the inputs directly: `subtle` requires `Uint8Array<ArrayBuffer>`,
  // and a `Buffer` (or anything else backed by `ArrayBufferLike`) does not satisfy that on its own.
  const keyBytes: Uint8Array<ArrayBuffer> = Uint8Array.from(key);
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: Uint8Array.from(iv) },
    cryptoKey,
    Uint8Array.from(plaintext),
  );
  return Buffer.from(encrypted);
};

/** The QIMEI protocol's own AES step: the same 16 bytes serve as both the key and the IV. */
const aesEncryptQimeiPayload = (key: Uint8Array, plaintext: Uint8Array): Promise<Buffer> =>
  aesCbcEncrypt(key, key, plaintext);

export const buildQimeiRequest = async (
  device: AndroidDevice,
  now = new Date(),
): Promise<Dictionary> => {
  const cryptKey = randomHex(16);
  const nonce = randomHex(16);
  const timestamp = Math.floor(now.getTime() / 1000);
  // The 16-*character* hex string above, re-encoded as UTF-8 bytes, is the 16-byte key material —
  // not a hex-decoded byte string. That is the exact input shape the original `Buffer.from(cryptKey)`
  // (default UTF-8 encoding) produced, and the upstream protocol expects it unchanged.
  const keyBytes = Buffer.from(cryptKey);
  const encryptedKey = rsaEncryptQimeiKey(keyBytes);
  const encryptedPayload = await aesEncryptQimeiPayload(
    keyBytes,
    Buffer.from(JSON.stringify(buildQimeiPayload(device, now))),
  );
  const key = encryptedKey.toString('base64');
  const params = encryptedPayload.toString('base64');
  const extra = `{"appKey":"${QIMEI_APP_KEY}"}`;
  return {
    headers: {
      Host: 'api.tencentmusic.com',
      method: 'GetQimei',
      service: 'trpc.tme_datasvr.qimeiproxy.QimeiProxy',
      appid: 'qimei_qq_android',
      sign: md5('qimei_qq_androidpzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH', String(timestamp)),
      'user-agent': 'QQMusic',
      timestamp: String(timestamp),
    },
    body: {
      app: 0,
      os: 1,
      qimeiParams: {
        key,
        params,
        time: String(timestamp),
        nonce,
        sign: md5(key, params, String(timestamp * 1000), nonce, QIMEI_SECRET, extra),
        extra,
      },
    },
  };
};

export const credentialMusicId = (credential: AndroidCommCredential): string => {
  const stringId = identifierOf(credential.str_musicid).trim();
  const rawId = identifierOf(credential.musicid).trim();
  return (
    (stringId && stringId !== '0' ? stringId : '') ||
    (rawId && rawId !== '0' ? rawId : '') ||
    stringId ||
    rawId
  );
};

export const buildAndroidComm = (
  device: AndroidDevice,
  credential?: AndroidCommCredential,
  overrides: Dictionary = {},
): Dictionary => ({
  ct: 11,
  cv: 14090008,
  v: 14090008,
  chid: CHANNEL_ID,
  tmeAppID: 'qqmusic',
  QIMEI: device.qimei ?? '',
  QIMEI36: device.qimei36 ?? '',
  OpenUDID: device.openUdid,
  udid: device.openUdid,
  OpenUDID2: device.openUdid,
  aid: device.androidId,
  os_ver: device.osRelease,
  phonetype: device.model,
  devicelevel: String(device.sdk),
  newdevicelevel: String(device.sdk),
  rom: device.fingerprint,
  ...(device.sessionUid ? { uid: device.sessionUid } : {}),
  ...(device.sessionSid ? { sid: device.sessionSid } : {}),
  ...(credential
    ? {
        qq: credentialMusicId(credential),
        authst: credential.musickey,
        tmeLoginType: credential.loginType,
      }
    : {}),
  ...overrides,
});
