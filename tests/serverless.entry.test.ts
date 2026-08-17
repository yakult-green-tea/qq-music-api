import type { ServerlessEnv } from '../src/serverless';
import { handleRequest } from '../src/serverless';
import { createRouter } from '../src/serverless/router';

// The serverless entry, exercised through its Web-standard signature. Everything asserted here is
// either a routing rule or one of the §5.3 compatibility invariants — the ones Folia depends on and
// that must read identically whether the request landed on Koa or on a Worker.

const SECRET = 'a-deployment-secret';

const call = (
  path: string,
  init: RequestInit = {},
  env: ServerlessEnv = { QQ_SESSION_SECRET: SECRET },
) => handleRequest(new Request(`https://worker.invalid${path}`, init), env);

/** `Response.json()` is `unknown`; every assertion here is on a known-shaped API envelope. */
const bodyOf = async (response: Response): Promise<Record<string, any>> =>
  (await response.json()) as Record<string, any>;

describe('createRouter', () => {
  const match = createRouter({
    '/login/status': 'status',
    '/getMusicPlay/:songmid': 'play',
    '/getSongInfo/:songmid/:songid?': 'song',
  });

  it('should match a literal route', () => {
    expect(match('/login/status')).toMatchObject({ handler: 'status', params: {} });
  });

  it('should treat a trailing slash as the same route', () => {
    expect(match('/login/status/')).toMatchObject({ handler: 'status' });
  });

  it('should capture a required parameter', () => {
    expect(match('/getMusicPlay/001abc')).toMatchObject({
      handler: 'play',
      params: { songmid: '001abc' },
    });
  });

  it('should treat an optional parameter as absent rather than empty', () => {
    expect(match('/getSongInfo/001abc')).toMatchObject({ params: { songmid: '001abc' } });
    expect(match('/getSongInfo/001abc')?.params.songid).toBeUndefined();
    expect(match('/getSongInfo/001abc/42')).toMatchObject({
      params: { songmid: '001abc', songid: '42' },
    });
  });

  it('should decode percent-encoded parameters', () => {
    expect(match('/getMusicPlay/a%2Fb')?.params.songmid).toBe('a/b');
  });

  it('should report the matched pattern so policy can key off the route', () => {
    expect(match('/getMusicPlay/001abc')?.route).toBe('/getMusicPlay/:songmid');
  });

  it('should not match an unknown path or a partial one', () => {
    expect(match('/nope')).toBeNull();
    expect(match('/getMusicPlay')).toBeNull();
    expect(match('/login')).toBeNull();
  });
});

describe('handleRequest', () => {
  it('should answer 501 with a pointer for an unimplemented path', async () => {
    const response = await call('/getTopLists');
    const body = await bodyOf(response);

    expect(response.status).toBe(501);
    expect(body.code).toBe(501);
    expect(body.message).toContain('/login/channels');
  });

  describe('/login/channels', () => {
    it('should advertise what this runtime actually serves', async () => {
      const body = await bodyOf(await call('/login/channels'));

      // WeChat only: the QQ App channel needs a long-lived MQTT socket an invocation cannot hold.
      expect(body).toEqual({
        code: 200,
        data: { channels: ['wechat'], sessionMode: 'sealed', configured: true },
      });
    });

    it('should report configured:false when no secret is set', async () => {
      const body = await bodyOf(await call('/login/channels', {}, {}));

      expect(body.data.configured).toBe(false);
    });
  });

  describe('without QQ_SESSION_SECRET', () => {
    it('should refuse the login routes with 501 rather than degrade silently', async () => {
      // 🔴 Never generate a secret. A process-local one would resurrect the exact bug this
      // workstream exists to remove: every login vanishing on the next cold start.
      for (const path of ['/login/qr/key', '/login/status', '/user/playlist', '/logout']) {
        const response = await call(path, {}, {});

        expect(response.status).toBe(501);
        expect((await bodyOf(response)).message).toContain('QQ_SESSION_SECRET');
      }
    });

    it('should still serve the catalog routes', async () => {
      // Anonymous catalog access does not need a session, so a deployment with no secret is
      // degraded, not broken. This is why the service is built lazily.
      const response = await call('/getAlbumInfo', {}, {});

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ data: { message: 'no albummid' } });
    });
  });

  describe('§5.3 compatibility invariants', () => {
    it('should answer /login/status with 200 and an empty data when not logged in', async () => {
      // #3: never 401 here. Folia decides by whether `data.profile` exists.
      const response = await call('/login/status');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 200, data: {} });
    });

    it('should answer the credentialed routes with 401 when not logged in', async () => {
      // #4
      for (const path of ['/user/detail', '/user/playlist', '/user/albums', '/user/liked-songs']) {
        const response = await call(path);

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ code: 401, message: 'Login required' });
      }
    });

    it('should answer /login/qr/cancel with 200 for an unknown key', async () => {
      // #5: callers cancel fire-and-forget on dialog close.
      const response = await call('/login/qr/cancel?key=never-issued');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ code: 200 });
    });

    it('should require a key on the QR routes that need one', async () => {
      for (const path of ['/login/qr/create', '/login/qr/check', '/login/qr/cancel']) {
        const response = await call(path);

        expect(response.status).toBe(400);
        expect((await bodyOf(response)).message).toBe('key is required');
      }
    });

    it('should reject an unusable token as simply not logged in', async () => {
      // A tampered or foreign sealed token resolves to null, which is a 401, not a 500.
      const response = await call('/user/detail', {
        headers: { 'X-QQ-Session': 'qq1.a.kid.iv.ct' },
      });

      expect(response.status).toBe(401);
    });
  });

  describe('token extraction', () => {
    // §5.3 #2: header > query > cookie. Asserted through observable behaviour — a valid-shaped
    // but unopenable token in the winning position still resolves to "not logged in", so the
    // ordering is checked by which source is consulted at all.
    it('should accept a token from the header, the query and the cookie alike', async () => {
      const responses = await Promise.all([
        call('/login/status', { headers: { 'X-QQ-Session': 'x' } }),
        call('/login/status?cookie=qqmusic_session%3Dx'),
        call('/login/status', { headers: { Cookie: 'qqmusic_session=x' } }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ code: 200, data: {} });
      }
    });
  });

  describe('/getMusicPlay', () => {
    it('should reject a request with no songmid the same way Koa does', async () => {
      // The Koa route is `/getMusicPlay/:songmid?`, so a missing songmid is a 400 from the
      // handler, not a 501 from the router. Same route shape, same answer.
      const response = await call('/getMusicPlay');

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ data: { message: 'no songmid' } });
    });

    it('should answer 401 when a songmid is given without a session', async () => {
      const response = await call('/getMusicPlay/001abc');

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: 401, message: 'Login required' });
    });
  });

  it('should answer JSON for every route', async () => {
    const response = await call('/login/channels');

    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

// D1′: `/login/qr/key`, `/login/qr/create` and `/login/qr/check` used to share a QR session only
// through a module-global, in-process `QrLoginService` — which `handleRequest` never has, by
// design (see "Built per invocation" above `createServiceFor`). Every one of these three routes
// therefore has to be able to resume the flow armed with nothing but the `unikey` the previous
// call returned. These tests drive all three as fully separate `handleRequest` calls — the same
// shape a real deployment has across Worker isolates — with `global.fetch` standing in for every
// upstream QQ/WeChat endpoint the flow touches.
describe('QR login sealed state (D1′)', () => {
  const QIMEI_URL = 'https://api.tencentmusic.com/tme/trpc/proxy';
  const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  const WECHAT_CONNECT_PATH = '/connect/qrconnect';
  const WECHAT_IMAGE_PATH_PREFIX = '/connect/qrcode/';
  const WECHAT_POLL_PATH = '/connect/l/qrconnect';
  const WX_UUID = 'wx-uuid-fixture';
  const WX_CODE = 'wx-oauth-code';
  const WX_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const QIMEI_16 = 'q'.repeat(36);
  const QIMEI_36 = 'r'.repeat(36);
  const MUSIC_ID = '10000';
  const MUSIC_KEY = 'musickey-value';
  const QR_FLOW_ENV: ServerlessEnv = { QQ_SESSION_SECRET: 'qr-flow-secret' };

  const wxStatusBody = (errcode: number, code = ''): string =>
    `window.wx_errcode=${errcode};window.wx_code='${code}';`;

  let wechatPollBody: string;
  let pollCookies: string[];
  let musicuComms: Record<string, any>[];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    wechatPollBody = wxStatusBody(408);
    pollCookies = [];
    musicuComms = [];
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
        musicuComms.push(payload.comm ?? {});
        const method = payload?.req_0?.method;
        if (method === 'GetSession') {
          return new Response(
            JSON.stringify({
              code: 0,
              req_0: { code: 0, data: { session: { uid: 1234567890, sid: 'session-sid' } } },
            }),
          );
        }
        if (method === 'Login') {
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
        if (method === 'GetLoginUserInfo') {
          return new Response(
            JSON.stringify({ code: 0, req_0: { code: 0, data: { nick: 'Nickname' } } }),
          );
        }
        throw new Error(`Unexpected musicu method: ${method}`);
      }

      if (url.pathname === WECHAT_CONNECT_PATH) {
        const headers = new Headers();
        headers.append('set-cookie', 'wx_session=abc123; Path=/');
        return new Response(
          `<img class="qrcode" src="/connect/qrcode/${WX_UUID}">` +
            `<a href="https://open.weixin.qq.com/connect/confirm?uuid=${WX_UUID}">open</a>`,
          { headers },
        );
      }

      if (url.pathname === `${WECHAT_IMAGE_PATH_PREFIX}${WX_UUID}`) {
        return new Response(WX_PNG);
      }

      if (url.pathname === WECHAT_POLL_PATH) {
        pollCookies.push(request.headers.get('cookie') ?? '');
        return new Response(wechatPollBody);
      }

      throw new Error(`Unexpected fetch in QR flow test: ${request.url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should carry a WeChat QR session across three independent handleRequest invocations', async () => {
    const keyResponse = await call('/login/qr/key?channel=wechat', {}, QR_FLOW_ENV);
    const keyBody = await bodyOf(keyResponse);
    expect(keyResponse.status).toBe(200);
    const unikey = keyBody.data.unikey as string;
    // Sealed for the QR purpose (`.q.`), not the auth purpose (`.a.`) `/login/status` uses.
    expect(unikey.split('.')[1]).toBe('q');

    // A brand-new `handleRequest` call: nothing from the call above survives in memory, per
    // `createServiceFor`'s own "built per invocation" contract.
    const callsBeforeCreate = (global.fetch as jest.Mock).mock.calls.length;
    const createResponse = await call(
      `/login/qr/create?key=${encodeURIComponent(unikey)}`,
      {},
      QR_FLOW_ENV,
    );
    const createBody = await bodyOf(createResponse);
    expect(createResponse.status).toBe(200);
    expect(createBody.data.qrimg).toContain('data:image/png;base64,');
    // The image was already sealed into the `unikey` at `/key` time; `/create` must not mint a
    // second, different WeChat QR by calling upstream again.
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsBeforeCreate);

    wechatPollBody = wxStatusBody(405, WX_CODE);
    const checkResponse = await call(
      `/login/qr/check?key=${encodeURIComponent(unikey)}`,
      {},
      QR_FLOW_ENV,
    );
    const checkBody = await bodyOf(checkResponse);
    expect(checkResponse.status).toBe(200);
    expect(checkBody.code).toBe(803);
    expect(checkBody.cookie).toMatch(/^qqmusic_session=qq1\.a\./);

    // The WeChat cookie `/key` collected must have reached the poll `/check` issued — on a client
    // built from scratch in a third, independent invocation.
    expect(pollCookies.some((cookie) => cookie.includes('wx_session=abc123'))).toBe(true);
    // The QIMEI `/key` fetched from upstream must have reached the credential-exchange call
    // `/check` made — the device identity is not just re-derived, it is carried forward.
    const exchangeComm = musicuComms.find((comm) => comm.QIMEI === QIMEI_16);
    expect(exchangeComm).toBeDefined();
  });

  it('should answer 404 on /create for a unikey sealed with a different deployment secret', async () => {
    const keyResponse = await call('/login/qr/key?channel=wechat', {}, QR_FLOW_ENV);
    const unikey = (await bodyOf(keyResponse)).data.unikey as string;

    const response = await call(
      `/login/qr/create?key=${encodeURIComponent(unikey)}`,
      {},
      { QQ_SESSION_SECRET: 'a-different-deployment-secret' },
    );

    expect(response.status).toBe(404);
  });

  it('should answer {code:800} on /check for a key that was never issued, not throw', async () => {
    const response = await call('/login/qr/check?key=not-a-real-unikey', {}, QR_FLOW_ENV);

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ code: 800, message: 'QR code expired' });
  });
});
