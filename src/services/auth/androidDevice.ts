import crypto from 'node:crypto';
import { type Dictionary, identifierOf } from './values';

// Synthetic Android device material and the QIMEI bootstrap request construction.
//
// Runtime-neutral by contract: `node:crypto` is the only platform dependency, and M0 0.1 proved
// on a real workerd instance that `publicEncrypt` (RSA_PKCS1), AES-128-CBC, MD5 and the random
// APIs used here all complete under `nodejs_compat`. Persistence (`node:fs`) lives in
// `deviceContext.ts` and the MQTT transport lives in `qrLogin.ts`, so neither reaches a
// serverless bundle through this file.
//
// Values here identify a synthetic device, never a user: no musickey, MQTT token or QR key is
// ever stored, logged or returned.

export const QIMEI_URL = 'https://api.tencentmusic.com/tme/trpc/proxy';
// Public Android client protocol constants, not user credentials.
const QIMEI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDEIxgwoutfwoJxcGQeedgP7FG9qaIuS0qzfR8gWkrkTZKM2iWHn2ajQpBRZjMSoSf6+KJGvar2ORhBfpDXyVtZCKpqLQ+FLkpncClKVIrBwv6PHyUvuCb0rIarmgDnzkfQAqVufEtR64iazGDKatvJ9y6B9NMbHddGSAUmRTCrHQIDAQAB
-----END PUBLIC KEY-----`;
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

export const md5 = (...values: string[]): string => {
  const hash = crypto.createHash('md5');
  for (const value of values) hash.update(value);
  return hash.digest('hex');
};

export const randomHex = (length: number): string =>
  crypto
    .randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);

export const randomDigits = (length: number): string => {
  let value = '';
  for (let index = 0; index < length; index += 1) value += crypto.randomInt(0, 10);
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
    else fields.push(`k${key}:${crypto.randomInt(0, 10000)}`);
  }
  return `${fields.join(';')};`;
};

const buildQimeiPayload = (device: AndroidDevice, now = new Date()): Dictionary => {
  const uptime = new Date(now.getTime() - crypto.randomInt(0, 14401) * 1000)
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

export const buildQimeiRequest = (device: AndroidDevice, now = new Date()): Dictionary => {
  const cryptKey = randomHex(16);
  const nonce = randomHex(16);
  const timestamp = Math.floor(now.getTime() / 1000);
  const encryptedKey = crypto.publicEncrypt(
    { key: QIMEI_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cryptKey),
  );
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(cryptKey), Buffer.from(cryptKey));
  const encryptedPayload = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(buildQimeiPayload(device, now)))),
    cipher.final(),
  ]);
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
