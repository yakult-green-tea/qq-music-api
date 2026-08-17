import { deriveAndroidDevice } from '../src/serverless/derivedDevice';
import { createSealedSessionResolver, toSealedCredential } from '../src/serverless/sealedResolver';
import {
  DERIVED_DEVICE_PURPOSE,
  deriveBits,
  openToken,
  SEALED_AUTH_PURPOSE,
  SEALED_QR_PURPOSE,
  SealedSessionError,
  sealToken,
} from '../src/serverless/sealedSession';
import type { AuthSession, QqCredential } from '../src/services/auth/qrLogin';

const SECRET = 'deployment-secret-one';
const OTHER_SECRET = 'deployment-secret-two';

const credentialFixture = (): QqCredential => ({
  musicid: '12345',
  str_musicid: '12345',
  musickey: 'must-not-leak',
  loginType: 2,
  encryptUin: 'encrypted-uin',
  nick: 'nickname',
  refresh_key: 'must-never-be-sealed',
  refresh_token: 'must-never-be-sealed',
  keyExpiresIn: 259200,
});

const sessionInput = (expiresAt: number): Omit<AuthSession, 'token'> => ({
  credential: credentialFixture(),
  device: {} as AuthSession['device'],
  expiresAt,
});

describe('sealed token envelope', () => {
  it('should round-trip a payload through the wire format', async () => {
    const token = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);

    expect(await openToken(token, SEALED_AUTH_PURPOSE, { current: SECRET })).toEqual({
      hello: 'world',
    });
  });

  it('should emit the documented five-segment wire format', async () => {
    const token = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);
    const segments = token.split('.');

    expect(segments).toHaveLength(5);
    expect(segments[0]).toBe('qq1');
    expect(segments[1]).toBe('a');
    // Nothing in the token may be readable: the credential is the payload, not a claims set.
    expect(token).not.toContain('world');
  });

  it('should use a fresh IV for every seal', async () => {
    const first = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);
    const second = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);

    expect(first).not.toBe(second);
  });

  it('should reject a tampered ciphertext', async () => {
    const token = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);
    const segments = token.split('.');
    // Flip one character of the ciphertext; GCM's tag must catch it.
    const body = segments[4];
    segments[4] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);

    await expect(
      openToken(segments.join('.'), SEALED_AUTH_PURPOSE, { current: SECRET }),
    ).rejects.toThrow(SealedSessionError);
  });

  it('should reject a token opened with the wrong key', async () => {
    const token = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);

    await expect(openToken(token, SEALED_AUTH_PURPOSE, { current: OTHER_SECRET })).rejects.toThrow(
      SealedSessionError,
    );
  });

  it('should reject a token sealed for another purpose', async () => {
    // Domain separation is the point: a QR token must not be usable as an auth token even though
    // the same deployment secret produced both.
    const qrToken = await sealToken({ hello: 'world' }, SEALED_QR_PURPOSE, SECRET);

    await expect(openToken(qrToken, SEALED_AUTH_PURPOSE, { current: SECRET })).rejects.toThrow(
      'Token was sealed for another purpose',
    );
  });

  it('should reject malformed tokens without attempting any key work', async () => {
    for (const malformed of ['', 'not-a-token', 'qq1.a.kid.iv', 'jwt.a.b.c.d']) {
      await expect(openToken(malformed, SEALED_AUTH_PURPOSE, { current: SECRET })).rejects.toThrow(
        SealedSessionError,
      );
    }
  });

  it('should reject an IV of the wrong length', async () => {
    const token = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);
    const segments = token.split('.');
    segments[3] = 'AAAA';

    await expect(
      openToken(segments.join('.'), SEALED_AUTH_PURPOSE, { current: SECRET }),
    ).rejects.toThrow('unusable length');
  });

  describe('rotation', () => {
    it('should still open a token sealed by the previous secret', async () => {
      const old = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, OTHER_SECRET);

      expect(
        await openToken(old, SEALED_AUTH_PURPOSE, { current: SECRET, previous: OTHER_SECRET }),
      ).toEqual({ hello: 'world' });
    });

    it('should invalidate old tokens when only current is set', async () => {
      // The documented cost of rotating without carrying the previous secret: everyone is logged
      // out at once. Pinned so it stays a decision rather than a surprise.
      const old = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, OTHER_SECRET);

      await expect(openToken(old, SEALED_AUTH_PURPOSE, { current: SECRET })).rejects.toThrow(
        'Token was sealed by an unknown key',
      );
    });
  });
});

describe('key derivation', () => {
  it('should derive unrelated keys for each purpose from one secret', async () => {
    const auth = await deriveBits(SECRET, SEALED_AUTH_PURPOSE, 32);
    const qr = await deriveBits(SECRET, SEALED_QR_PURPOSE, 32);
    const device = await deriveBits(SECRET, DERIVED_DEVICE_PURPOSE, 32);

    expect(Buffer.from(auth).toString('hex')).not.toBe(Buffer.from(qr).toString('hex'));
    expect(Buffer.from(auth).toString('hex')).not.toBe(Buffer.from(device).toString('hex'));
    expect(Buffer.from(qr).toString('hex')).not.toBe(Buffer.from(device).toString('hex'));
  });

  it('should refuse to derive from an empty secret', async () => {
    // Never silently fall back to a process-local key: that is the bug this mode exists to fix.
    await expect(deriveBits('', SEALED_AUTH_PURPOSE, 32)).rejects.toThrow(SealedSessionError);
  });
});

describe('deriveAndroidDevice', () => {
  it('should be deterministic for a given secret', async () => {
    expect(await deriveAndroidDevice(SECRET)).toEqual(await deriveAndroidDevice(SECRET));
  });

  it('should give different secrets different identities', async () => {
    const first = await deriveAndroidDevice(SECRET);
    const second = await deriveAndroidDevice(OTHER_SECRET);

    expect(first.androidId).not.toBe(second.androidId);
    expect(first.imei).not.toBe(second.imei);
  });

  it('should produce a device of the same shape the Node generator produces', async () => {
    const device = await deriveAndroidDevice(SECRET);

    expect(device.imei).toMatch(/^\d{15}$/);
    expect(device.androidId).toMatch(/^[0-9a-f]{16}$/);
    expect(device.openUdid).toMatch(/^[0-9a-f]{32}$/);
    expect(device.display).toMatch(/^QMAPI\.\d{6}\.001$/);
    expect(device.model).toBe('MI 6');
    expect(device.sdk).toBe(29);
  });

  it('should carry a valid Luhn check digit', async () => {
    const { imei } = await deriveAndroidDevice(SECRET);
    const digits = imei.split('').map(Number);
    let sum = 0;
    for (let index = 0; index < 14; index += 1) {
      let digit = digits[index];
      if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }

    expect(digits[14]).toBe((10 - (sum % 10)) % 10);
  });
});

describe('toSealedCredential', () => {
  it('should drop every field outside the allowlist', async () => {
    const sealed = toSealedCredential(credentialFixture());

    expect(Object.keys(sealed).sort()).toEqual([
      'encryptUin',
      'loginType',
      'musicid',
      'musickey',
      'nick',
      'str_musicid',
    ]);
  });

  it('should keep all nine allowlisted fields when upstream returns them', async () => {
    const sealed = toSealedCredential({
      ...credentialFixture(),
      nickname: 'nickname',
      logo: 'https://example.invalid/logo.png',
      avatarUrl: 'https://example.invalid/avatar.png',
    });

    expect(Object.keys(sealed)).toHaveLength(9);
  });

  it('should drop allowlisted fields upstream did not return', async () => {
    // Absent is not the same as null: writing `undefined` into the token would grow it and give
    // downstream code a field that exists but means nothing.
    const sealed = toSealedCredential({ musicid: '1', musickey: 'k', loginType: 2 });

    expect(Object.keys(sealed).sort()).toEqual(['loginType', 'musicid', 'musickey']);
  });

  it('should never carry refresh material', async () => {
    // 🔴 The single most important assertion in this file. Including refresh material would extend
    // a leaked token's reach from the session lifetime to the refresh lifetime.
    const sealed = toSealedCredential(credentialFixture());

    expect(sealed).not.toHaveProperty('refresh_key');
    expect(sealed).not.toHaveProperty('refresh_token');
    expect(JSON.stringify(sealed)).not.toContain('must-never-be-sealed');
  });
});

describe('createSealedSessionResolver', () => {
  const resolverFor = (now: () => number = Date.now) =>
    createSealedSessionResolver({ secrets: { current: SECRET }, now });

  it('should declare the sealed mode', () => {
    expect(resolverFor().mode).toBe('sealed');
  });

  it('should issue a token that resolves back to a usable session', async () => {
    const resolver = resolverFor();
    const expiresAt = Date.now() + 60_000;

    const token = await resolver.issue(sessionInput(expiresAt));
    const resolved = await resolver.resolve(token);

    expect(resolved?.expiresAt).toBe(expiresAt);
    expect(resolved?.credential.musickey).toBe('must-not-leak');
    expect(resolved?.token).toBe(token);
  });

  it('should reconstruct the derived device rather than carrying it in the token', async () => {
    const resolver = resolverFor();
    const token = await resolver.issue(sessionInput(Date.now() + 60_000));

    const resolved = await resolver.resolve(token);

    expect(resolved?.device).toEqual(await deriveAndroidDevice(SECRET));
    // The device is 13 fields; carrying it would roughly double the token for no benefit.
    expect(token).not.toContain('sagit');
  });

  it('should strip refresh material on the way into the token', async () => {
    const resolver = resolverFor();
    const token = await resolver.issue(sessionInput(Date.now() + 60_000));

    const resolved = await resolver.resolve(token);

    expect(resolved?.credential).not.toHaveProperty('refresh_key');
    expect(resolved?.credential).not.toHaveProperty('refresh_token');
  });

  it('should answer null for a missing, unopenable or expired token', async () => {
    const now = Date.now();
    const resolver = resolverFor(() => now);

    expect(await resolver.resolve(undefined)).toBeNull();
    expect(await resolver.resolve('')).toBeNull();
    expect(await resolver.resolve('qq1.a.kid.iv.ct')).toBeNull();
    expect(await resolver.resolve(await resolver.issue(sessionInput(now - 1)))).toBeNull();
  });

  it('should reject a token whose sealed credential is unusable', async () => {
    // Authentication proves the deployment wrote it, not that upstream returned a usable
    // credential. A session missing `musickey` must not resolve into a doomed upstream call.
    const token = await sealToken(
      { v: 1, iat: Date.now(), exp: Date.now() + 60_000, cred: { musicid: '1', loginType: 2 } },
      SEALED_AUTH_PURPOSE,
      SECRET,
    );

    expect(await resolverFor().resolve(token)).toBeNull();
  });

  it('should treat revoke as a no-op that leaves the token usable', async () => {
    // 🔴 The documented semantic difference from `stored`. Logout means the client discards the
    // token; there is no server-side record to delete, and the exposure is bounded by expiry.
    const resolver = resolverFor();
    const token = await resolver.issue(sessionInput(Date.now() + 60_000));

    await resolver.revoke(token);

    expect(await resolver.resolve(token)).not.toBeNull();
  });

  it('should not expose the stored-only lifecycle hooks', async () => {
    const resolver = resolverFor();

    expect(resolver.cleanup).toBeUndefined();
    expect(resolver.useRepository).toBeUndefined();
  });
});
