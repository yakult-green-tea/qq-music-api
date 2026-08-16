import {
  AUTH_SESSION_STORE_PURPOSE,
  openJson,
  SessionCryptoError,
  sealJson,
} from '../src/services/auth/sessionCrypto';

const SECRET = 'deployment-secret-value';
const OTHER_PURPOSE = 'qq-music-api/v1/some-other-use';
const PAYLOAD = [{ token: 'abc', nested: { musickey: 'must-not-leak', count: 3 } }];

const envelopeOf = (serialized: string): Record<string, unknown> =>
  JSON.parse(serialized) as Record<string, unknown>;

const reseal = (serialized: string, patch: Record<string, unknown>): string =>
  JSON.stringify({ ...envelopeOf(serialized), ...patch });

describe('session crypto envelope', () => {
  it('should round-trip a value through seal and open', () => {
    const sealed = sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE);

    expect(openJson(sealed, SECRET, AUTH_SESSION_STORE_PURPOSE)).toEqual(PAYLOAD);
  });

  it('should keep the plaintext out of the sealed form', () => {
    const sealed = sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE);

    expect(sealed).not.toContain('must-not-leak');
    expect(sealed).not.toContain('abc');
    expect(envelopeOf(sealed)).toMatchObject({ v: 1, alg: 'aes-256-gcm' });
  });

  it('should produce a different ciphertext every time for the same input', () => {
    // A fresh salt and IV per write. Equal envelopes would leak that the state did not change.
    const first = envelopeOf(sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE));
    const second = envelopeOf(sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE));

    expect(first.salt).not.toEqual(second.salt);
    expect(first.iv).not.toEqual(second.iv);
    expect(first.ct).not.toEqual(second.ct);
  });

  it('should reject a tampered ciphertext', () => {
    const sealed = sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE);
    const original = Buffer.from(String(envelopeOf(sealed).ct), 'base64');
    original[0] ^= 0xff;

    expect(() =>
      openJson(
        reseal(sealed, { ct: original.toString('base64') }),
        SECRET,
        AUTH_SESSION_STORE_PURPOSE,
      ),
    ).toThrow(SessionCryptoError);
  });

  it('should reject the wrong secret', () => {
    const sealed = sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE);

    expect(() => openJson(sealed, 'a-rotated-secret', AUTH_SESSION_STORE_PURPOSE)).toThrow(
      SessionCryptoError,
    );
  });

  it('should reject a different purpose even under the same secret', () => {
    // Domain separation: this is what stops persisted session state and any other future use of
    // `QQ_SESSION_SECRET` from being interchangeable.
    const sealed = sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE);

    expect(() => openJson(sealed, SECRET, OTHER_PURPOSE)).toThrow(SessionCryptoError);
  });

  it('should reject an unsupported version or algorithm', () => {
    const sealed = sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE);

    expect(() => openJson(reseal(sealed, { v: 2 }), SECRET, AUTH_SESSION_STORE_PURPOSE)).toThrow(
      /unsupported envelope version/i,
    );
    expect(() =>
      openJson(reseal(sealed, { alg: 'aes-128-gcm' }), SECRET, AUTH_SESSION_STORE_PURPOSE),
    ).toThrow(/unsupported envelope version/i);
  });

  it('should reject a truncated or missing envelope field', () => {
    const sealed = sealJson(PAYLOAD, SECRET, AUTH_SESSION_STORE_PURPOSE);
    const shortIv = Buffer.alloc(4).toString('base64');

    expect(() =>
      openJson(reseal(sealed, { iv: shortIv }), SECRET, AUTH_SESSION_STORE_PURPOSE),
    ).toThrow(/unusable length/i);
    expect(() =>
      openJson(reseal(sealed, { salt: undefined }), SECRET, AUTH_SESSION_STORE_PURPOSE),
    ).toThrow(/is missing/i);
    expect(() =>
      openJson(
        reseal(sealed, { ct: Buffer.alloc(4).toString('base64') }),
        SECRET,
        AUTH_SESSION_STORE_PURPOSE,
      ),
    ).toThrow(/unusable length/i);
  });

  it('should reject state that is not an envelope at all', () => {
    expect(() => openJson('not json', SECRET, AUTH_SESSION_STORE_PURPOSE)).toThrow(
      /not a readable envelope/i,
    );
    expect(() => openJson('[]', SECRET, AUTH_SESSION_STORE_PURPOSE)).toThrow(
      /not a readable envelope/i,
    );
  });

  it('should refuse to work without a secret', () => {
    expect(() => sealJson(PAYLOAD, '', AUTH_SESSION_STORE_PURPOSE)).toThrow(SessionCryptoError);
    expect(() => openJson('{}', '', AUTH_SESSION_STORE_PURPOSE)).toThrow(SessionCryptoError);
  });
});
