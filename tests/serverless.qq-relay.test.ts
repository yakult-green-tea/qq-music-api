import type { QqQrRelay, QrEvent, ServerlessEnv } from '../src/serverless';
import { handleRequest } from '../src/serverless';

// S7-a: the QQ App channel on a serverless runtime.
//
// The channel is MQTT over a WebSocket whose CONNECT asks for a clean session and whose
// subscription is unicast, so nothing published while disconnected is replayed. A request-scoped
// invocation cannot hold that socket, which is why this runtime serves the channel only when a host
// injects a `QqQrRelay` — something that can. These tests drive the three QR routes as fully
// separate `handleRequest` calls, the shape a real deployment has across isolates, with a fake
// relay standing in for the host's Durable Object and `global.fetch` for every upstream endpoint.

const QIMEI_URL = 'https://api.tencentmusic.com/tme/trpc/proxy';
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QRCODE_ID = 'qrcode-id-fixture';
const MQTT_TOKEN = 'mqtt-exchange-token';
const MUSIC_ID = '10000';
const MUSIC_KEY = 'musickey-value';
const QIMEI_16 = 'q'.repeat(36);
const QIMEI_36 = 'r'.repeat(36);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const QR_IMAGE = `data:image/png;base64,${PNG.toString('base64')}`;
const QR_ENV: ServerlessEnv = { QQ_SESSION_SECRET: 'qq-relay-secret' };

/** The MQTT `cookies` payload, exactly as `exchangeQqLogin` reads it. */
const cookiesEvent: QrEvent = {
  type: 'cookies',
  payload: { cookies: { qqmusic_uin: { value: MUSIC_ID }, qqmusic_key: { value: MQTT_TOKEN } } },
};

const bodyOf = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

const createFakeRelay = () => {
  const opened: Array<{ qrcodeId: string; image: string; ttlMs: number }> = [];
  const closed: string[] = [];
  const polled: Array<{ qrcodeId: string; budgetMs: number }> = [];
  let events: QrEvent[] = [];
  let pollFailure: Error | null = null;
  const relay: QqQrRelay = {
    open: async (qrcodeId, image, ttlMs) => {
      opened.push({ qrcodeId, image, ttlMs });
    },
    image: async () => QR_IMAGE,
    poll: async (qrcodeId, budgetMs) => {
      polled.push({ qrcodeId, budgetMs });
      if (pollFailure) {
        const failure = pollFailure;
        pollFailure = null;
        throw failure;
      }
      return events;
    },
    close: async (qrcodeId) => {
      closed.push(qrcodeId);
    },
  };
  return {
    relay,
    opened,
    closed,
    polled,
    /** The relay contract is "the whole ordered list so far", not a delta — see `QqQrRelay`. */
    observe: (...next: QrEvent[]) => {
      events = next;
    },
    failNextPoll: (error: Error) => {
      pollFailure = error;
    },
  };
};

describe('serverless QQ App channel over a relay', () => {
  let loginParams: Record<string, any>[];
  let musicuMethods: string[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    loginParams = [];
    musicuMethods = [];
    originalFetch = global.fetch;
    global.fetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const key = `${url.origin}${url.pathname}`;

      if (key === QIMEI_URL) {
        return new Response(
          JSON.stringify({
            data: JSON.stringify({ code: 0, data: { q16: QIMEI_16, q36: QIMEI_36 } }),
          }),
        );
      }

      if (key === MUSICU_URL) {
        const payload = JSON.parse(String(init?.body ?? '{}'));
        const method = payload?.req_0?.method;
        musicuMethods.push(method);
        if (method === 'GetSession') {
          return new Response(
            JSON.stringify({
              code: 0,
              req_0: { code: 0, data: { session: { uid: 1234567890, sid: 'session-sid' } } },
            }),
          );
        }
        if (method === 'CreateQRCode') {
          return new Response(
            JSON.stringify({
              code: 0,
              req_0: { code: 0, data: { qrcodeID: QRCODE_ID, qrcode: QR_IMAGE, expiresIn: 120 } },
            }),
          );
        }
        if (method === 'Login') {
          loginParams.push(payload.req_0.param);
          return new Response(
            JSON.stringify({
              code: 0,
              req_0: {
                code: 0,
                data: {
                  musicid: MUSIC_ID,
                  str_musicid: MUSIC_ID,
                  musickey: MUSIC_KEY,
                  encryptUin: 'encrypted-uin',
                  musickeyCreateTime: Math.floor(Date.now() / 1000),
                  keyExpiresIn: 259200,
                },
              },
            }),
          );
        }
        throw new Error(`Unexpected musicu method: ${method}`);
      }

      throw new Error(`Unexpected fetch in QQ relay test: ${request.url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const call = (path: string, relay?: QqQrRelay) =>
    handleRequest(
      new Request(`https://worker.invalid${path}`),
      QR_ENV,
      relay ? { qqRelay: relay } : {},
    );

  /** Runs `/login/qr/key` and hands back the `unikey` the client would be holding. */
  const issueKey = async (relay: QqQrRelay): Promise<string> => {
    const body = await bodyOf(await call('/login/qr/key?channel=qq', relay));
    return body.data.unikey as string;
  };

  describe('capability declaration', () => {
    it('should advertise only wechat when no relay is injected', async () => {
      const body = await bodyOf(await call('/login/channels'));

      expect(body.data.channels).toEqual(['wechat']);
    });

    it('should advertise qq as well once a relay is injected', async () => {
      const body = await bodyOf(await call('/login/channels', createFakeRelay().relay));

      expect(body.data.channels).toEqual(['qq', 'wechat']);
    });

    it('should reject channel=qq without a relay rather than failing further in', async () => {
      // A missing relay is a capability statement, not a 500: `createSession` validates the
      // requested channel against what this runtime declared.
      const response = await call('/login/qr/key?channel=qq');

      expect(response.status).toBe(400);
      expect((await bodyOf(response)).message).toContain('qq');
    });
  });

  describe('/login/qr/key', () => {
    it('should subscribe the relay before handing back a scannable code', async () => {
      const fake = createFakeRelay();

      const unikey = await issueKey(fake.relay);

      // Opened exactly once, with the code the upstream just minted and a live TTL. A second
      // socket for one QR is a second billed connection, and a code shown before the subscription
      // exists can lose its `scanned`/`cookies` events outright.
      expect(fake.opened).toHaveLength(1);
      expect(fake.opened[0]).toMatchObject({ qrcodeId: QRCODE_ID, image: QR_IMAGE });
      expect(fake.opened[0].ttlMs).toBeGreaterThan(0);
      expect(unikey.split('.')[1]).toBe('q');
    });

    it('should keep the unikey short by leaving the image with the relay', async () => {
      // The QR is a base64 PNG; sealing it into a URL query parameter is what §sealedQrState
      // rejected for WeChat, and the App channel's code is no smaller.
      const unikey = await issueKey(createFakeRelay().relay);

      expect(unikey.length).toBeLessThan(2000);
      expect(unikey).not.toContain(PNG.toString('base64'));
    });
  });

  describe('/login/qr/create', () => {
    it('should re-fetch the image from the relay and never mint a second code', async () => {
      const fake = createFakeRelay();
      const unikey = await issueKey(fake.relay);
      musicuMethods.length = 0;

      const body = await bodyOf(
        await call(`/login/qr/create?key=${encodeURIComponent(unikey)}`, fake.relay),
      );

      expect(body.data.qrimg).toBe(QR_IMAGE);
      // 🔴 A second `CreateQRCode` would hand the user a different code from the one the relay is
      // subscribed to, so the QR on screen would never resolve — and it would orphan a live socket.
      expect(musicuMethods).not.toContain('CreateQRCode');
      expect(fake.opened).toHaveLength(1);
    });
  });

  describe('/login/qr/check', () => {
    it('should report waiting while the relay has seen nothing but the subscription', async () => {
      const fake = createFakeRelay();
      const unikey = await issueKey(fake.relay);
      fake.observe({ type: 'waiting', payload: null });

      const body = await bodyOf(
        await call(`/login/qr/check?key=${encodeURIComponent(unikey)}`, fake.relay),
      );

      expect(body.code).toBe(801);
      expect(fake.polled[0]).toMatchObject({ qrcodeId: QRCODE_ID });
      expect(fake.polled[0].budgetMs).toBeGreaterThan(0);
    });

    it('should report scanned from a replayed event list, not from remembered state', async () => {
      // 🔴 The invocation answering this request rebuilds the session as `waiting` — it has no
      // memory of the one before it. Only because the relay replays the whole list can it learn
      // that a scan happened at all.
      const fake = createFakeRelay();
      const unikey = await issueKey(fake.relay);
      fake.observe({ type: 'waiting', payload: null }, { type: 'scanned', payload: null });

      const body = await bodyOf(
        await call(`/login/qr/check?key=${encodeURIComponent(unikey)}`, fake.relay),
      );

      expect(body.code).toBe(802);
    });

    it('should exchange the credential with the qrCodeID the key was sealed with', async () => {
      const fake = createFakeRelay();
      const unikey = await issueKey(fake.relay);
      fake.observe(
        { type: 'waiting', payload: null },
        { type: 'scanned', payload: null },
        cookiesEvent,
      );

      const body = await bodyOf(
        await call(`/login/qr/check?key=${encodeURIComponent(unikey)}`, fake.relay),
      );

      expect(body.code).toBe(803);
      expect(body.cookie).toContain('qqmusic_session=');
      // 🔴 `exchangeQqLogin` reads `qrcodeId`, not `identifier`. A replayed record that restored
      // only `identifier` throws here — after the user has already approved on their phone.
      expect(loginParams).toHaveLength(1);
      expect(loginParams[0]).toMatchObject({ qrCodeID: QRCODE_ID, token: MQTT_TOKEN });
    });

    it('should report an expired code once the relay observes a terminal event', async () => {
      const fake = createFakeRelay();
      const unikey = await issueKey(fake.relay);
      fake.observe({ type: 'timeout', payload: null });

      const body = await bodyOf(
        await call(`/login/qr/check?key=${encodeURIComponent(unikey)}`, fake.relay),
      );

      expect(body.code).toBe(800);
    });

    it('should tolerate one failed poll rather than failing the login', async () => {
      // A dropped relay call is normal; only a run of them is a real failure. Matching the WeChat
      // pull channel here keeps a single blip from turning a live QR into "expired".
      const fake = createFakeRelay();
      const unikey = await issueKey(fake.relay);
      fake.failNextPoll(new Error('relay unavailable'));

      const body = await bodyOf(
        await call(`/login/qr/check?key=${encodeURIComponent(unikey)}`, fake.relay),
      );

      expect(body.code).toBe(801);
    });
  });

  describe('/login/qr/cancel', () => {
    it('should release the relay socket before answering', async () => {
      // 🔴 Awaited, not fire-and-forget. `cancelSession` operates on the service's QR store, which
      // is empty on a fresh sealed invocation, so it has never released anything here — harmless
      // for WeChat, which owns nothing between calls, and a connection billed for the rest of the
      // QR's life for this channel.
      const fake = createFakeRelay();
      const unikey = await issueKey(fake.relay);

      const response = await call(`/login/qr/cancel?key=${encodeURIComponent(unikey)}`, fake.relay);

      expect(response.status).toBe(200);
      expect(fake.closed).toEqual([QRCODE_ID]);
    });

    it('should still answer 200 for a key it cannot open', async () => {
      // §5.3 #5: callers cancel fire-and-forget on dialog close, so an unknown or tampered key is
      // a success, never an error.
      const fake = createFakeRelay();

      const response = await call('/login/qr/cancel?key=not-a-real-unikey', fake.relay);

      expect(response.status).toBe(200);
      expect(fake.closed).toEqual([]);
    });
  });
});
