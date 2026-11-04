import './helpers/sessionRoutes';
import request from 'supertest';
import app from '../src/app';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

const WRITES = [
  '/login/refresh',
  '/user/song/like',
  '/user/album/subscribe',
  '/user/playlist/tracks',
  '/user/playlist/create',
  '/user/playlist/rename',
  '/user/playlist/delete',
  '/user/playlist/subscribe',
  '/user/blacklist/add',
  '/user/blacklist/remove',
  '/user/recommendation-preferences/update',
];
const GETS = [
  '/logout',
  '/login/qr/key?channel=invalid',
  '/login/qr/create?key=fixture',
  '/login/qr/cancel?key=fixture',
  '/login/qr/check?key=fixture',
];
const BODIES: Record<string, unknown> = {
  '/login/refresh': {},
  '/user/song/like': { song: { id: 101, mid: 'FixtureSongA1', type: 0 }, liked: true },
  '/user/album/subscribe': { id: 'FixtureAlbumA1', subscribed: true },
  '/user/playlist/tracks': { tid: '70001', op: 'add', songs: [{ id: 101, type: 0 }] },
  '/user/playlist/create': { name: 'Fixture playlist' },
  '/user/playlist/rename': { tid: 70001, name: 'Fixture renamed' },
  '/user/playlist/delete': { tid: 70001 },
  '/user/playlist/subscribe': { tid: 70001, subscribed: true },
  '/user/blacklist/add': { songs: ['123'] },
  '/user/blacklist/remove': { type: 'song', id: '123', idType: 1 },
  '/user/recommendation-preferences/update': { profiles: [{ key: '10008', score: 75 }] },
};

describe.each(CATALOG_RUNTIMES)('write safety: %s', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    process.env.QQ_UNVERIFIED_WRITES_ENABLED = '1';
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.QQ_UNVERIFIED_WRITES_ENABLED;
    else process.env.QQ_UNVERIFIED_WRITES_ENABLED = previous;
  });

  it.each(WRITES)('%s: credential sources and fetch site', async (path) => {
    const options = await upstream.options('valid');
    const token = options.token ?? '';
    const send = async (
      source: 'header' | 'cookie' | 'query',
      site?: string,
      extra: Record<string, string> = {},
    ) => {
      await options.beforeEachLeg?.();
      const headers: Record<string, string> = {
        ...extra,
        ...(site ? { 'Sec-Fetch-Site': site } : {}),
      };
      if (source === 'header') headers['X-QQ-Session'] = token;
      if (source === 'cookie') headers.Cookie = `qqmusic_session=${token}`;
      const query =
        source === 'query' ? `?cookie=${encodeURIComponent(`qqmusic_session=${token}`)}` : '';
      return callRoute(runtime, `${path}${query}`, {
        method: 'POST',
        body: BODIES[path],
        headers,
        env: { ...options.env, QQ_UNVERIFIED_WRITES_ENABLED: '1' },
      });
    };
    const baseline = await send('header');
    expect(baseline.status).not.toBe(401);
    expect(await send('cookie', 'same-origin')).toEqual(baseline);
    expect(await send('cookie', 'none')).toEqual(baseline);
    expect(await send('cookie')).toEqual(baseline);
    expect(await send('query', 'cross-site')).toEqual(baseline);
    expect(await send('query', 'cross-site', { Cookie: 'qqmusic_session=invalid' })).toEqual(
      baseline,
    );
    expect(await send('header', 'same-site', { Cookie: 'qqmusic_session=invalid' })).toEqual(
      baseline,
    );
    for (const site of ['same-site', 'cross-site']) {
      upstream.calls.length = 0;
      expect(await send('cookie', site)).toEqual({
        status: 403,
        body: { code: 403, message: 'cross-site request refused' },
      });
      expect(upstream.calls).toHaveLength(0);
    }
  });

  it.each(GETS)('%s: GET behavior remains unchanged', async (path) => {
    const options = await upstream.options('valid');
    const headers = { Cookie: `qqmusic_session=${options.token}` };
    await options.beforeEachLeg?.();
    const baseline = await callRoute(runtime, path, { headers, env: options.env });
    await options.beforeEachLeg?.();
    const cross = await callRoute(runtime, path, {
      headers: { ...headers, 'Sec-Fetch-Site': 'same-site' },
      env: options.env,
    });
    expect(cross).toEqual(baseline);
  });
  it('does not block the read-only POST /song/batch', async () => {
    const options = await upstream.options('valid');
    const headers = { Cookie: `qqmusic_session=${options.token}` };
    const base = await callRoute(runtime, '/song/batch', {
      method: 'POST',
      body: { mids: ['FixtureSongA1'] },
      headers,
      env: options.env,
    });
    const cross = await callRoute(runtime, '/song/batch', {
      method: 'POST',
      body: { mids: ['FixtureSongA1'] },
      headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
      env: options.env,
    });
    expect(cross).toEqual(base);
  });
  if (runtime === 'serverless')
    it.each(
      WRITES,
    )('%s refuses cross-site Cookie before checking the deployment secret', async (path) => {
      const result = await callRoute(runtime, path, {
        method: 'POST',
        body: BODIES[path],
        headers: { Cookie: 'qqmusic_session=fixture', 'Sec-Fetch-Site': 'same-site' },
      });
      expect(result).toEqual({
        status: 403,
        body: { code: 403, message: 'cross-site request refused' },
      });
      expect(upstream.calls).toHaveLength(0);
    });
  if (runtime === 'node')
    it('refuses cross-site cookie writes before parsing malformed JSON', async () => {
      const options = await upstream.options('valid');
      const result = await request(app.callback())
        .post('/user/blacklist/add')
        .set('Cookie', `qqmusic_session=${options.token}`)
        .set('Sec-Fetch-Site', 'same-site')
        .set('Content-Type', 'application/json')
        .send('{');
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ code: 403, message: 'cross-site request refused' });
      expect(upstream.calls).toHaveLength(0);
    });
});
