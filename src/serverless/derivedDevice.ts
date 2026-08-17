import type { AndroidDevice } from '../services/auth/androidDevice';
import { DERIVED_DEVICE_PURPOSE, deriveBits } from './sealedSession';

/**
 * The device identity a serverless runtime uses, derived from the deployment secret instead of
 * stored. Node keeps its device in a state file; a Worker has no such file and every invocation
 * may land on a different machine, so the identity has to be reproducible from something the
 * deployment already has.
 *
 * 🔴 The assumption this encodes, which belongs in the deployment documentation: one deployment
 * secret is one device identity, so a deployment is a single-user, personal deployment. Two people
 * sharing one `QQ_SESSION_SECRET` share a device fingerprint upstream. Per-client device identity
 * is a future direction; `SealedTokenV1` carries a version field so it can arrive without breaking
 * tokens already issued.
 *
 * The type is imported type-only on purpose: the Node device module reaches `node:crypto` for its
 * random generator, and nothing from it should end up in the serverless bundle.
 */

const DERIVED_BYTES = 64;

/** Consumes the derived stream in fixed-size bites so field order alone fixes the whole device. */
const createReader = (bytes: Uint8Array) => {
  let cursor = 0;
  const take = (count: number): Uint8Array => {
    // The stream is sized for every field below with room to spare; wrapping keeps a future field
    // from silently reading zeroes if that ever stops being true.
    const slice = new Uint8Array(count);
    for (let index = 0; index < count; index += 1)
      slice[index] = bytes[(cursor + index) % bytes.length];
    cursor += count;
    return slice;
  };
  return {
    hex: (length: number): string =>
      Array.from(take(Math.ceil(length / 2)), (byte) => byte.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, length),
    digits: (length: number): string =>
      Array.from(take(length), (byte) => String(byte % 10)).join(''),
  };
};

/** Same Luhn check digit the random generator applies, so the value stays a well-formed IMEI. */
const imeiFrom = (fourteenDigits: string): string => {
  const digits = fourteenDigits.split('').map(Number);
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits[index];
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  digits.push((10 - (sum % 10)) % 10);
  return digits.join('');
};

/**
 * Deterministic: the same secret always produces the same device, on every instance, with nothing
 * written down. The constant fields match `createAndroidDevice()` exactly — this is the same
 * device model presented to upstream, only with its variable parts derived rather than rolled.
 */
export const deriveAndroidDevice = async (secret: string): Promise<AndroidDevice> => {
  const read = createReader(await deriveBits(secret, DERIVED_DEVICE_PURPOSE, DERIVED_BYTES));
  return {
    display: `QMAPI.${read.digits(6)}.001`,
    product: 'iarim',
    device: 'sagit',
    board: 'eomam',
    model: 'MI 6',
    fingerprint: `xiaomi/iarim/sagit:10/eomam.200122.001/${read.digits(7)}:user/release-keys`,
    procVersion: `Linux 5.4.0-54-generic-${read.hex(8)} (android-build@google.com)`,
    imei: imeiFrom(read.digits(14)),
    brand: 'Xiaomi',
    androidId: read.hex(16),
    openUdid: read.hex(32),
    osRelease: '10',
    sdk: 29,
  };
};
