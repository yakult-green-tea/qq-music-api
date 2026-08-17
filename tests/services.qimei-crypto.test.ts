import crypto from 'node:crypto';
import {
  aesCbcEncrypt,
  buildQimeiRequest,
  createAndroidDevice,
  md5,
  rsaesPkcs1Encrypt,
} from '../src/services/auth/androidDevice';

// H1 Vercel §8.4: `androidDevice.ts` used to build its QIMEI bootstrap envelope on `node:crypto`
// (`publicEncrypt`, `createCipheriv`, `createHash('md5')`) — a Vercel Edge Function refuses to
// deploy a bundle that imports `node:crypto` at all, unlike Cloudflare's opt-in `nodejs_compat`.
// These three primitives are now hand-rolled (MD5, RSAES-PKCS1-v1_5) or Web-Crypto-based
// (AES-CBC) instead, and this file is what proves they still do the same job: MD5 and AES are
// checked byte-for-byte against `node:crypto`; RSA is checked by an encrypt/decrypt round trip
// through a throwaway keypair, since there is no private key for the real QIMEI bootstrap key to
// decrypt a specific ciphertext with.

const b64UrlToHex = (value: string): string =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex');

describe('md5', () => {
  it('should match node:crypto createHash("md5") across a range of inputs', () => {
    const cases = [
      '',
      'a',
      'abc',
      'message digest',
      'The quick brown fox jumps over the lazy dog',
      'x'.repeat(1000),
    ];
    for (const value of cases) {
      expect(md5(value)).toBe(crypto.createHash('md5').update(value).digest('hex'));
    }
  });

  it('should hash concatenated arguments the same way streamed hash.update() calls would', () => {
    const parts = ['qimei_qq_android', 'pzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH', '1234567890'];
    const streamed = crypto.createHash('md5');
    for (const part of parts) streamed.update(part);

    expect(md5(...parts)).toBe(streamed.digest('hex'));
  });

  it('should stay correct for input spanning multiple 64-byte blocks', () => {
    const long = 'y'.repeat(200);

    expect(md5(long)).toBe(crypto.createHash('md5').update(long).digest('hex'));
  });
});

describe('rsaesPkcs1Encrypt', () => {
  it('should produce a ciphertext node:crypto can decrypt, round-tripped through a fresh keypair', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const modulusHex = b64UrlToHex(jwk.n);
    const exponent = BigInt(`0x${b64UrlToHex(jwk.e)}`);

    // 16 bytes: the same size as the AES key `buildQimeiRequest` actually encrypts with this.
    const message = Buffer.from('0123456789abcdef', 'utf8');
    const ciphertext = rsaesPkcs1Encrypt(message, modulusHex, exponent);

    expect(ciphertext.length).toBe(modulusHex.length / 2);
    // Patched Node 20 builds reject RSA_PKCS1_PADDING private decryption after CVE-2023-46809.
    // Raw RSA lets the test verify the same encoded block without asking OpenSSL to unpad it.
    const encoded = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_NO_PADDING },
      ciphertext,
    );
    expect(encoded[0]).toBe(0);
    expect(encoded[1]).toBe(2);
    const separator = encoded.indexOf(0, 2);
    expect(separator).toBeGreaterThanOrEqual(10);
    expect(encoded.subarray(2, separator).every((byte) => byte !== 0)).toBe(true);
    expect(encoded.subarray(separator + 1).equals(message)).toBe(true);
  });

  it('should randomise padding so the same message never encrypts to the same ciphertext', () => {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const modulusHex = b64UrlToHex(jwk.n);
    const exponent = BigInt(`0x${b64UrlToHex(jwk.e)}`);
    const message = Buffer.from('same message every time');

    const first = rsaesPkcs1Encrypt(message, modulusHex, exponent);
    const second = rsaesPkcs1Encrypt(message, modulusHex, exponent);

    expect(first.equals(second)).toBe(false);
  });

  it('should reject a message too long for the key, mirroring RFC 8017 §7.2.1', () => {
    const modulusHex = 'ff'.repeat(16); // a 128-bit key for this one check
    expect(() => rsaesPkcs1Encrypt(Buffer.alloc(20), modulusHex, 65537n)).toThrow('too long');
  });
});

describe('aesCbcEncrypt', () => {
  it('should match node:crypto createCipheriv("aes-128-cbc", key, iv) byte-for-byte', async () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const plaintext = Buffer.from(JSON.stringify({ a: 1, b: 'hello world', c: [1, 2, 3] }));

    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const expected = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    const actual = await aesCbcEncrypt(key, iv, plaintext);

    expect(actual.equals(expected)).toBe(true);
  });

  it('should apply PKCS7 padding even for an already block-aligned plaintext', async () => {
    const key = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const plaintext = Buffer.alloc(16, 0x41); // exactly one AES block

    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    const expected = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const actual = await aesCbcEncrypt(key, iv, plaintext);

    expect(actual.length).toBe(32); // the plaintext block plus one full padding block
    expect(actual.equals(expected)).toBe(true);
  });
});

describe('buildQimeiRequest', () => {
  it('should still build a valid envelope now that it is async', async () => {
    const request = await buildQimeiRequest(createAndroidDevice());

    expect(request.headers).toMatchObject({ method: 'GetQimei', appid: 'qimei_qq_android' });
    const body = request.body as { qimeiParams: { key: string; sign: string } };
    // RSA-1024 against the real QIMEI bootstrap key: a 128-byte ciphertext, base64-encoded.
    expect(Buffer.from(body.qimeiParams.key, 'base64')).toHaveLength(128);
    expect(body.qimeiParams.sign).toMatch(/^[0-9a-f]{32}$/);
  });

  it('should mint a fresh session key on every call', async () => {
    const device = createAndroidDevice();

    const first = await buildQimeiRequest(device);
    const second = await buildQimeiRequest(device);

    const firstBody = first.body as { qimeiParams: { key: string } };
    const secondBody = second.body as { qimeiParams: { key: string } };
    expect(firstBody.qimeiParams.key).not.toBe(secondBody.qimeiParams.key);
  });
});
