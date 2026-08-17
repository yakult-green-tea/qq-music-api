import type { AuthSession, QqCredential, SessionResolver } from '../services/auth/qrLogin';
import { deriveAndroidDevice } from './derivedDevice';
import { openToken, SEALED_AUTH_PURPOSE, SealedSessionError, sealToken } from './sealedSession';

/**
 * The `sealed` backend for the `SessionResolver` port.
 *
 * Two things make it behave differently from `stored`, and both are deliberate:
 *
 * - `revoke()` is a no-op. There is no server-side record to delete, so a sealed token stays
 *   usable until it expires and logout means the client discarding it. A denylist would reintroduce
 *   exactly the shared mutable state this mode exists to avoid; the exposure is bounded by the
 *   session lifetime instead.
 * - The credential is reduced to an allowlist before it is sealed. Whatever new fields upstream
 *   starts returning, they do not silently become part of a token that travels through clients.
 */

/**
 * `SealedCredentialV1` — the nine fields a session actually needs downstream. Everything else in a
 * `QqCredential` is dropped.
 *
 * 🔴 `refresh_key` and `refresh_token` are excluded by design, not by oversight. They extend an
 * account's reach far past the session itself, and keeping them out is what bounds the blast radius
 * of a leaked token to the session lifetime rather than the refresh lifetime.
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

interface SealedPayloadV1 {
  v: 1;
  iat: number;
  exp: number;
  cred: Record<string, unknown>;
}

/** Drops every field outside the allowlist, and every allowlisted field that is absent upstream. */
export const toSealedCredential = (credential: QqCredential): Record<string, unknown> => {
  const reduced: Record<string, unknown> = {};
  for (const field of SEALED_CREDENTIAL_FIELDS) {
    const value = (credential as Record<string, unknown>)[field];
    if (value !== undefined) reduced[field] = value;
  }
  return reduced;
};

const isSealedPayload = (value: unknown): value is SealedPayloadV1 => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === 1 &&
    typeof candidate.iat === 'number' &&
    Number.isFinite(candidate.iat) &&
    typeof candidate.exp === 'number' &&
    Number.isFinite(candidate.exp) &&
    typeof candidate.cred === 'object' &&
    candidate.cred !== null &&
    !Array.isArray(candidate.cred)
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

export const createSealedSessionResolver = (options: {
  secrets: { current: string; previous?: string };
  now?: () => number;
}): SessionResolver => {
  const now = options.now ?? Date.now;
  return {
    mode: 'sealed',
    issue: async (session) =>
      sealToken(
        {
          v: 1,
          iat: now(),
          exp: session.expiresAt,
          cred: toSealedCredential(session.credential),
        } satisfies SealedPayloadV1,
        SEALED_AUTH_PURPOSE,
        options.secrets.current,
      ),
    resolve: async (token) => {
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
      return {
        token,
        credential: payload.cred as QqCredential,
        device: await deriveAndroidDevice(options.secrets.current),
        expiresAt: payload.exp,
      } satisfies AuthSession;
    },
    // Intentionally empty: see the note at the top of this file.
    revoke: async () => {},
  };
};
