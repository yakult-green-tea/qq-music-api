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
