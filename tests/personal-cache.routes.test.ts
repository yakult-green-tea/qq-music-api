import './helpers/sessionRoutes';
import request from 'supertest';
import app from '../src/app';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

const PRIVATE_ROUTES: Array<[string, 'GET' | 'POST']> = [
  ['/user/blacklist/add', 'POST'],
  ['/user/blacklist/remove', 'POST'],
  ['/radio/recommendation-modes', 'GET'],
  ['/radio/recommendation-tracks', 'GET'],
  ['/user/blacklist', 'GET'],
  ['/user/blacklist/style-options', 'GET'],
  ['/user/daily-songs/history/dates', 'GET'],
  ['/user/daily-songs/history', 'GET'],
  ['/user/recommendation-preferences/update', 'POST'],
  ['/user/recommendation-preferences', 'GET'],
  ['/user/listening-rank', 'GET'],
  ['/user/guess-you-like/modes', 'GET'],
  ['/recommend/feed', 'GET'],
  ['/user/personal-fm', 'GET'],
  ['/song/replacement', 'GET'],
  ['/user/guess-you-like/tracks', 'GET'],
];

describe.each(CATALOG_RUNTIMES)('private cache headers: %s', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  it.each(PRIVATE_ROUTES)('%s keeps errors private', async (path, method) => {
    const options = await upstream.options('missing');
    await options.beforeEachLeg?.();
    const result = await callRoute(runtime, path, {
      method,
      ...(method === 'POST' ? { body: {} } : {}),
      env: options.env,
      responseHeaders: ['cache-control'],
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.headers?.['cache-control']).toEqual(['private, no-store']);
  });
  it('keeps successful personalized data private', async () => {
    upstream.state.rpcReplies = { GetRank: { data: { from: 0, token: '', rank: [] } } };
    const options = await upstream.options('valid');
    await options.beforeEachLeg?.();
    const result = await callRoute(runtime, '/user/listening-rank?range=day', {
      headers: { 'X-QQ-Session': options.token ?? '' },
      env: options.env,
      responseHeaders: ['cache-control'],
    });
    expect(result.status).toBe(200);
    expect(result.headers?.['cache-control']).toEqual(['private, no-store']);
  });
  it('does not add private cache headers to an anonymous route', async () => {
    const result = await callRoute(runtime, '/song/versions', {
      responseHeaders: ['cache-control'],
    });
    expect(result.headers?.['cache-control']).toEqual([]);
  });
  it('keeps a method rejection private', async () => {
    const result = await callRoute(runtime, '/user/listening-rank?range=day', {
      method: 'DELETE',
      env: { QQ_SESSION_SECRET: 'fixture-secret' },
      responseHeaders: ['cache-control'],
    });
    expect(result.status).toBe(405);
    expect(result.headers?.['cache-control']).toEqual(['private, no-store']);
  });
  if (runtime === 'serverless')
    it('keeps a missing deployment secret error private', async () => {
      const result = await callRoute(runtime, '/user/listening-rank?range=day', {
        responseHeaders: ['cache-control'],
      });
      expect(result.status).toBe(501);
      expect(result.headers?.['cache-control']).toEqual(['private, no-store']);
    });
  if (runtime === 'node')
    it('keeps a malformed JSON error private', async () => {
      const response = await request(app.callback())
        .post('/user/blacklist/add')
        .set('Content-Type', 'application/json')
        .send('{');
      expect(response.status).toBe(400);
      expect(response.headers['cache-control']).toBe('private, no-store');
    });
});
