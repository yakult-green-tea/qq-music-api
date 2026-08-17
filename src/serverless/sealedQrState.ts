import { isSupportedLoginChannel, type QrLoginChannel } from '../services/auth/qrLogin';
import { openToken, SEALED_QR_PURPOSE, SealedSessionError, sealToken } from './sealedSession';

/**
 * D1′: the `sealed` half of the QR login state, for the same reason `sealedResolver.ts` exists for
 * the post-login session — a Worker isolate that built the QR (`/login/qr/key`) is not the isolate
 * that will answer `/login/qr/create` or `/login/qr/check`. Nothing about the QR flow may live in
 * memory between those calls; it has to travel inside the `unikey` the client already holds.
 *
 * What travels: the upstream QR `identifier` (WeChat's `uuid`), discovered once at `/key` time and
 * never reissued — reconnecting would mint a second, different WeChat QR under the same `unikey` —
 * the per-session cookie jar the WeChat web flow deposited getting there, and the device fields
 * `ensureQimei`/`refreshAndroidSession` obtained from a live upstream call. None of the three is
 * reconstructible: `deriveAndroidDevice` only recreates the *static* device fields deterministically,
 * and `qimei`/`qimei36`/`sessionUid`/`sessionSid` are live values a fresh isolate has no way to ask
 * for again without repeating the bootstrap `/login/qr/key` already paid for.
 *
 * 🔴 The QR *image* is deliberately not one of these fields. It is tens of KB of base64 PNG, and
 * `unikey` travels as a URL query parameter — sealing the image bloated it past what some HTTP
 * clients (and PowerShell's `EscapeDataString`) will accept. `identifier` is enough to re-fetch it:
 * see `fetchWechatQrImage` and the `session.identifier` branch in `createWechatQrDriver`.
 */

/** The live device fields a fresh isolate cannot re-derive; see `deriveAndroidDevice`. */
export interface SealedQrDeviceStateV1 {
  qimei?: string;
  qimei36?: string;
  qimeiSavedAt?: number;
  sessionUid?: string;
  sessionSid?: string;
  sessionVkey?: unknown;
}

export interface SealedQrPayloadV1 {
  v: 1;
  channel: QrLoginChannel;
  createdAt: number;
  expiresAt: number;
  identifier: string;
  /** The WeChat-session HTTP client's cookie jar at the moment `/login/qr/key` finished. */
  cookies: string;
  device: SealedQrDeviceStateV1;
}

const isDeviceState = (value: unknown): value is SealedQrDeviceStateV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const optionalText = (key: string): boolean =>
    candidate[key] === undefined || typeof candidate[key] === 'string';
  return (
    optionalText('qimei') &&
    optionalText('qimei36') &&
    optionalText('sessionUid') &&
    optionalText('sessionSid') &&
    (candidate.qimeiSavedAt === undefined || Number.isFinite(candidate.qimeiSavedAt))
  );
};

const isSealedQrPayload = (value: unknown): value is SealedQrPayloadV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    isSupportedLoginChannel(candidate.channel) &&
    Number.isFinite(candidate.createdAt) &&
    Number.isFinite(candidate.expiresAt) &&
    typeof candidate.identifier === 'string' &&
    candidate.identifier.length > 0 &&
    typeof candidate.cookies === 'string' &&
    isDeviceState(candidate.device)
  );
};

/** Seals a freshly created QR session's state into the token that becomes the client's `unikey`. */
export const sealQrState = (
  payload: Omit<SealedQrPayloadV1, 'v'>,
  secret: string,
): Promise<string> =>
  sealToken({ v: 1, ...payload } satisfies SealedQrPayloadV1, SEALED_QR_PURPOSE, secret);

/**
 * Opens a `unikey` back into the state it was sealed with. Answers `null` for anything that is not
 * a live, authentic QR token — tampered, foreign-purpose, unopenable with either secret, malformed,
 * or past `expiresAt` — so a caller can treat "no session" uniformly, exactly like `sessionFor` did
 * for the in-memory store this replaces.
 */
export const openQrState = async (
  token: string,
  secrets: { current: string; previous?: string },
  now: number,
): Promise<SealedQrPayloadV1 | null> => {
  let payload: unknown;
  try {
    payload = await openToken(token, SEALED_QR_PURPOSE, secrets);
  } catch (error) {
    if (error instanceof SealedSessionError) return null;
    throw error;
  }
  if (!isSealedQrPayload(payload)) return null;
  if (payload.expiresAt <= now) return null;
  return payload;
};
