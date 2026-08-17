import { openQrState, type SealedQrPayloadV1, sealQrState } from '../src/serverless/sealedQrState';
import { SEALED_AUTH_PURPOSE, SEALED_QR_PURPOSE, sealToken } from '../src/serverless/sealedSession';

// D1′: the QR session state that used to live in a module-global `Map` inside `QrLoginServiceImpl`.
// These tests are at the codec level only — round-tripping a payload through `sealQrState`/
// `openQrState` — the same layer `serverless.sealed-session.test.ts` tests for the auth token.
// The end-to-end "three separate `handleRequest` calls share one QR flow" behaviour is asserted in
// `serverless.entry.test.ts`, against the actual route handlers.

const SECRET = 'qr-deployment-secret';
const OTHER_SECRET = 'qr-deployment-secret-two';

const payloadFixture = (overrides: Partial<Omit<SealedQrPayloadV1, 'v'>> = {}) => ({
  channel: 'wechat' as const,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  identifier: 'wx-uuid-fixture',
  imageUrl: 'data:image/png;base64,AAAA',
  cookies: 'a=1; b=2',
  device: {
    qimei: 'q16',
    qimei36: 'q36',
    qimeiSavedAt: Date.now(),
    sessionUid: 'uid',
    sessionSid: 'sid',
  },
  ...overrides,
});

describe('sealQrState / openQrState', () => {
  it('should round-trip a QR session through the wire format', async () => {
    const payload = payloadFixture();
    const token = await sealQrState(payload, SECRET);

    const opened = await openQrState(token, { current: SECRET }, Date.now());

    expect(opened).toEqual({ v: 1, ...payload });
  });

  it('should tag the token with the QR purpose, not the auth purpose', async () => {
    const token = await sealQrState(payloadFixture(), SECRET);

    expect(token.split('.')[1]).toBe('q');
  });

  it('should answer null for a token sealed for the auth purpose', async () => {
    // Domain separation: an auth token presented where a `unikey` is expected must not resolve.
    const authToken = await sealToken({ hello: 'world' }, SEALED_AUTH_PURPOSE, SECRET);

    expect(await openQrState(authToken, { current: SECRET }, Date.now())).toBeNull();
  });

  it('should answer null for a token opened with the wrong secret', async () => {
    const token = await sealQrState(payloadFixture(), SECRET);

    expect(await openQrState(token, { current: OTHER_SECRET }, Date.now())).toBeNull();
  });

  it('should still open a token sealed by the previous secret', async () => {
    const token = await sealQrState(payloadFixture(), OTHER_SECRET);

    const opened = await openQrState(
      token,
      { current: SECRET, previous: OTHER_SECRET },
      Date.now(),
    );

    expect(opened?.identifier).toBe('wx-uuid-fixture');
  });

  it('should answer null for a tampered ciphertext', async () => {
    const token = await sealQrState(payloadFixture(), SECRET);
    const segments = token.split('.');
    segments[4] = (segments[4][0] === 'A' ? 'B' : 'A') + segments[4].slice(1);

    expect(await openQrState(segments.join('.'), { current: SECRET }, Date.now())).toBeNull();
  });

  it('should answer null for a malformed token without throwing', async () => {
    for (const malformed of ['', 'not-a-token', 'qq1.q.kid.iv']) {
      await expect(openQrState(malformed, { current: SECRET }, Date.now())).resolves.toBeNull();
    }
  });

  it('should answer null once the sealed expiry has passed', async () => {
    const now = Date.now();
    const token = await sealQrState(payloadFixture({ expiresAt: now - 1 }), SECRET);

    expect(await openQrState(token, { current: SECRET }, now)).toBeNull();
  });

  it('should carry the WeChat cookie jar and the live device fields, not just the QR handle', async () => {
    // The two things a fresh Worker isolate cannot rebuild on its own: the per-session cookie jar
    // the WeChat web flow deposited, and the live QIMEI/session fields `ensureQimei` and
    // `refreshAndroidSession` fetched. Losing either would silently break `/login/qr/check` on the
    // very first request that lands on a different isolate than `/login/qr/key` did.
    const token = await sealQrState(payloadFixture(), SECRET);

    const opened = await openQrState(token, { current: SECRET }, Date.now());

    expect(opened?.cookies).toBe('a=1; b=2');
    expect(opened?.device).toMatchObject({
      qimei: 'q16',
      qimei36: 'q36',
      sessionUid: 'uid',
      sessionSid: 'sid',
    });
  });

  it('should reject a payload missing the fields the QR flow needs to resume', async () => {
    const incomplete = {
      v: 1,
      channel: 'wechat',
      createdAt: Date.now(),
      expiresAt: Date.now() + 1000,
    };
    const token = await sealToken(incomplete, SEALED_QR_PURPOSE, SECRET);

    expect(await openQrState(token, { current: SECRET }, Date.now())).toBeNull();
  });
});
