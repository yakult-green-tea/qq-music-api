import { authSessionExpiryAt } from '../services/auth/credentialExpiry';
import type {
  AuthSession,
  QqCredential,
  SessionResolver,
  SessionRotation,
} from '../services/auth/qrLogin';
import { AUTH_REFRESH_EARLY_MS, AUTH_REFRESH_RETRY_MS } from '../services/auth/sessionState';
import { deriveAndroidDevice } from './derivedDevice';
import { openToken, SEALED_AUTH_PURPOSE, SealedSessionError, sealToken } from './sealedSession';

/**
 * The `sealed` backend for the `SessionResolver` port.
 *
 * Three things make it behave differently from `stored`, and all are deliberate:
 *
 * - `revoke()` is a no-op. There is no server-side record to delete, so a sealed token stays
 *   usable until it expires and logout means the client discarding it. A denylist would reintroduce
 *   exactly the shared mutable state this mode exists to avoid; the exposure is bounded by the
 *   session lifetime instead.
 * - The credential is reduced to an allowlist before it is sealed. Whatever new fields upstream
 *   starts returning, they do not silently become part of a token that travels through clients.
 * - Renewal hands out a new token (`rotate`), and only when the client asks for it through
 *   `POST /login/refresh`. Measured in 2026-10: after a refresh the old musickey kept working for at
 *   least ten minutes on both QQ and WeChat, so the old token is left to expire on its own and a
 *   client that fails to store the new one simply renews again next time.
 */

/**
 * `SealedCredentialV1` — the nine fields a session actually needs downstream. Everything else in a
 * `QqCredential` is dropped from `cred`.
 */
const SEALED_CREDENTIAL_FIELDS = [
  'musicid',
  'str_musicid',
  'musickey',
  'loginType',
  'encryptUin',
  'nick',
  'nickname',
  'logo',
  'avatarUrl',
] as const;

/**
 * 🔴 What a refresh needs, kept apart from `cred` so ordinary reads never see it. Sealing it widens
 * what a leaked token can do — it can be renewed — which is why every v2 token carries `born` and
 * renewal stops at `SEALED_MAX_LIFETIME_MS` after the original login.
 */
const REFRESH_FIELDS = [
  'refresh_key',
  'refresh_token',
  'openid',
  'unionid',
  'access_token',
] as const;

/** Total lifetime from the original login; renewal never extends a session past it. */
export const SEALED_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounds the per-instance bookkeeping below; a Worker isolate can serve many accounts. */
const ROTATION_STATE_LIMIT = 500;

interface SealedPayloadV1 {
  v: 1;
  iat: number;
  exp: number;
  cred: Record<string, unknown>;
}

interface SealedPayloadV2 {
  v: 2;
  iat: number;
  exp: number;
  /** When the user originally scanned; carried unchanged through every renewal. */
  born: number;
  cred: Record<string, unknown>;
  rf?: Record<string, string>;
}

type SealedPayload = SealedPayloadV1 | SealedPayloadV2;

/** Drops every field outside the allowlist, and every allowlisted field that is absent upstream. */
export const toSealedCredential = (credential: QqCredential): Record<string, unknown> => {
  const reduced: Record<string, unknown> = {};
  for (const field of SEALED_CREDENTIAL_FIELDS) {
    const value = (credential as Record<string, unknown>)[field];
    if (value !== undefined) reduced[field] = value;
  }
  return reduced;
};

const refreshMaterialOf = (credential: Record<string, unknown>): Record<string, string> => {
  const material: Record<string, string> = {};
  for (const field of REFRESH_FIELDS) {
    const value = credential[field];
    if (typeof value === 'string' && value.length > 0) material[field] = value;
  }
  return material;
};

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSealedPayload = (value: unknown): value is SealedPayload => {
  if (!isRecord(value)) return false;
  if (!finiteNumber(value.iat) || !finiteNumber(value.exp) || !isRecord(value.cred)) return false;
  if (value.v === 1) return true;
  if (value.v !== 2 || !finiteNumber(value.born)) return false;
  return (
    value.rf === undefined ||
    (isRecord(value.rf) && Object.values(value.rf).every((entry) => typeof entry === 'string'))
  );
};

/**
 * A decrypted payload is authentic but still has to be a usable credential: authentication proves
 * the deployment wrote it, not that upstream returned everything the session needs.
 */
const isUsableCredential = (value: Record<string, unknown>): boolean => {
  const hasMusicId =
    (typeof value.musicid === 'string' && value.musicid.length > 0) ||
    (typeof value.musicid === 'number' && Number.isFinite(value.musicid));
  return (
    hasMusicId &&
    typeof value.musickey === 'string' &&
    value.musickey.length > 0 &&
    typeof value.loginType === 'number' &&
    Number.isFinite(value.loginType)
  );
};

/**
 * Per-instance only, by design: the next request may land on another isolate that knows nothing of
 * this. A failed refresh waits `AUTH_REFRESH_RETRY_MS` here before trying again, and two concurrent
 * requests for the same token share one upstream refresh.
 */
const retryAt = new Map<string, number>();
const inFlight = new Map<string, Promise<SessionRotation | null>>();

const remember = <T>(map: Map<string, T>, key: string, value: T): void => {
  map.delete(key);
  map.set(key, value);
  while (map.size > ROTATION_STATE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};

export const createSealedSessionResolver = (options: {
  secrets: { current: string; previous?: string };
  now?: () => number;
}): SessionResolver => {
  const now = options.now ?? Date.now;

  const seal = (payload: SealedPayloadV2): Promise<string> =>
    sealToken(payload, SEALED_AUTH_PURPOSE, options.secrets.current);

  const sealFor = (credential: QqCredential, expiresAt: number, born: number) => {
    const material = refreshMaterialOf(credential as Record<string, unknown>);
    return seal({
      v: 2,
      iat: now(),
      exp: expiresAt,
      born,
      cred: toSealedCredential(credential),
      ...(Object.keys(material).length > 0 ? { rf: material } : {}),
    });
  };

  /** Opens a token into a live payload, or `null` for anything that is not a current session. */
  const open = async (token: string | undefined): Promise<SealedPayload | null> => {
    if (!token) return null;
    let payload: unknown;
    try {
      payload = await openToken(token, SEALED_AUTH_PURPOSE, options.secrets);
    } catch (error) {
      // A token that does not open is simply not logged in. Distinguishing "tampered" from
      // "expired secret" for the caller would only help someone probing the deployment.
      if (error instanceof SealedSessionError) return null;
      throw error;
    }
    if (!isSealedPayload(payload)) return null;
    // Expiry is inside the ciphertext, so GCM already proved nobody moved it. Checking it here
    // is what replaces the stored backend's periodic cleanup.
    if (payload.exp <= now()) return null;
    if (!isUsableCredential(payload.cred)) return null;
    return payload;
  };

  const sessionOf = async (
    token: string,
    payload: SealedPayload,
    credential: Record<string, unknown> = payload.cred,
  ): Promise<AuthSession> => ({
    token,
    credential: credential as QqCredential,
    device: await deriveAndroidDevice(options.secrets.current),
    expiresAt: payload.exp,
  });

  const rotateOnce = async (
    token: string,
    payload: SealedPayload,
    refresh: (session: AuthSession) => Promise<QqCredential>,
  ): Promise<SessionRotation> => {
    const unchanged = { token, expiresAt: payload.exp, rotated: false };
    // A v1 token has no refresh material and no original login time, so it is left to expire.
    if (payload.v !== 2 || !payload.rf || Object.keys(payload.rf).length === 0) return unchanged;
    const current = now();
    if (current <= payload.exp - AUTH_REFRESH_EARLY_MS) return unchanged;
    const cap = payload.born + SEALED_MAX_LIFETIME_MS;
    if (payload.exp >= cap || (retryAt.get(token) ?? 0) > current) return unchanged;
    try {
      const renewed = await refresh(
        await sessionOf(token, payload, { ...payload.cred, ...payload.rf }),
      );
      const expiresAt = Math.min(authSessionExpiryAt(renewed, now()), cap);
      if (expiresAt <= payload.exp) return unchanged;
      retryAt.delete(token);
      const material = { ...payload.rf, ...refreshMaterialOf(renewed as Record<string, unknown>) };
      return {
        token: await sealFor({ ...renewed, ...material }, expiresAt, payload.born),
        expiresAt,
        rotated: true,
      };
    } catch {
      // The old key is still valid for the rest of its lifetime, so a failed refresh is not an
      // outage; it only must not turn into one upstream call per request.
      remember(retryAt, token, now() + AUTH_REFRESH_RETRY_MS);
      return unchanged;
    }
  };

  return {
    mode: 'sealed',
    issue: async (session) => sealFor(session.credential, session.expiresAt, now()),
    lookup: async (token) => {
      const payload = await open(token);
      return payload && token ? sessionOf(token, payload) : null;
    },
    resolve: async (token) => {
      const payload = await open(token);
      return payload && token ? sessionOf(token, payload) : null;
    },
    // Intentionally empty: see the note at the top of this file.
    revoke: async () => {},
    rotate: async (token, refresh) => {
      const pending = inFlight.get(token);
      if (pending) return pending;
      const work = (async () => {
        const payload = await open(token);
        return payload ? rotateOnce(token, payload, refresh) : null;
      })();
      remember(inFlight, token, work);
      try {
        return await work;
      } finally {
        if (inFlight.get(token) === work) inFlight.delete(token);
      }
    },
  };
};
