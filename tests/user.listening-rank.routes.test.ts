import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 个人听歌排行（ListenReportSvr/GetRank）：type 1 日／2 周／3 月／4 年，date 可省。
// 周的边界、token 的用途、有没有上限都还没有真账号证据，这里只验请求形状与回包处理。
// 歌曲与编号都是虚构示例。

const track = (n: number) => ({
  id: 100 + n,
  mid: `fixtureRank${n}`,
  name: `fixture song ${n}`,
});
const DATA = {
  from: 0,
  token: 'fixture-next',
  rank: [
    { track: track(1), listenCnt: 12 },
    { track: track(2), listenCnt: 3 },
  ],
};
const RANK = '/user/listening-rank';

describe.each(CATALOG_RUNTIMES)('/user/listening-rank（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const call = async (
    path: string,
    mode: 'valid' | 'missing' | 'invalid' | 'expired' = 'valid',
  ) => {
    const options = await upstream.options(mode);
    await options.beforeEachLeg?.();
    return callRoute(runtime, path, {
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: options.env,
    });
  };
  const rpcs = () => upstream.calls.flatMap((c) => c.rpc);
  beforeEach(() => {
    upstream.state.rpcReplies = { GetRank: { data: DATA } };
  });

  it.each([
    ['day', 1],
    ['week', 2],
    ['month', 3],
    ['year', 4],
  ] as const)('reads the current %s period as type %i without a date', async (range, type) => {
    const result = await call(`${RANK}?range=${range}`);

    expect(result).toEqual({
      status: 200,
      body: {
        code: 200,
        range,
        from: 0,
        token: 'fixture-next',
        items: [
          { track: track(1), listenCount: 12 },
          { track: track(2), listenCount: 3 },
        ],
      },
    });
    expect(rpcs()).toEqual([
      {
        module: 'music.individuation.ListenReportSvr',
        method: 'GetRank',
        param: { type, uin: '', version: 'v2', token: '' },
      },
    ]);
  });

  it.each([
    ['day', '20261101'],
    ['week', '20261026'],
    ['week', '20261102'],
    ['month', '202610'],
  ] as const)('forwards a history date for %s: %s', async (range, date) => {
    const result = await call(`${RANK}?range=${range}&date=${date}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ range, date });
    expect(rpcs()[0].param).toMatchObject({ date });
  });

  it('forwards the opaque token as is and omits an empty reply token', async () => {
    upstream.state.rpcReplies = { GetRank: { data: { ...DATA, token: '' } } };
    const result = await call(`${RANK}?range=week&token=fixture-cursor`);
    expect(rpcs()[0].param).toMatchObject({ type: 2, token: 'fixture-cursor' });
    expect(result.body).not.toHaveProperty('token');
  });

  it.each([
    null,
    [],
  ])('answers an empty period (%j) as 200 with no items, not as an error', async (rank) => {
    upstream.state.rpcReplies = {
      GetRank: { data: { from: 0, token: '', rank } },
    };
    const result = await call(`${RANK}?range=day&date=20261101`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: 200, range: 'day', items: [] });
  });

  it.each([
    'requires a range',
    '?range=all',
    '?range=Week',
    '?range=week&uin=10001',
    '?range=week&page=2',
    '?range=week&limit=5',
    '?range=week&date=2026-11-02',
    '?range=week&date=20261302',
    '?range=week&date=20260230',
    '?range=week&date=202611',
    '?range=day&date=202611',
    '?range=month&date=20261101',
    '?range=month&date=202613',
    '?range=year&date=2026',
    '?range=year&date=20261101',
    `?range=week&token=${'x'.repeat(513)}`,
    '?range=week&token=',
    '?range=week&token=a%20b',
  ])('rejects bad input without calling upstream: %s', async (query) => {
    const path = query === 'requires a range' ? RANK : `${RANK}${query}`;
    expect((await call(path)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('rejects a repeated range', async () => {
    expect((await call(`${RANK}?range=week&range=day`)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('rejects DELETE before reading repeated parameters', async () => {
    const options = await upstream.options('valid');
    await options.beforeEachLeg?.();
    const result = await callRoute(runtime, `${RANK}?range=day&range=year`, {
      method: 'DELETE',
      headers: { 'X-QQ-Session': options.token ?? '' },
      env: options.env,
      responseHeaders: ['allow'],
    });
    expect(result.status).toBe(405);
    expect(result.headers?.allow?.[0]).toContain('GET');
    expect(upstream.calls).toHaveLength(0);
  });

  it('accepts HEAD for a GET route', async () => {
    const options = await upstream.options('valid');
    await options.beforeEachLeg?.();
    const result = await callRoute(runtime, `${RANK}?range=day`, {
      method: 'HEAD',
      headers: { 'X-QQ-Session': options.token ?? '' },
      env: options.env,
    });
    expect(result.status).toBe(200);
  });

  it('rejects DELETE even without a configured session secret', async () => {
    const result = await callRoute(runtime, `${RANK}?range=day&range=year`, {
      method: 'DELETE',
      responseHeaders: ['allow'],
    });
    expect(result.status).toBe(405);
    expect(result.headers?.allow?.[0]).toContain('GET');
  });

  it.each([
    'missing',
    'invalid',
    'expired',
  ] as const)('requires a valid session: %s', async (mode) => {
    expect((await call(`${RANK}?range=week`, mode)).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    {},
    [],
    { rank: {} },
    { rank: 'x' },
    { rank: [null] },
    { rank: [{ listenCnt: 1 }] },
    { rank: [{ track: [], listenCnt: 1 }] },
    { rank: [{ track: track(1) }] },
    { rank: [{ track: track(1), listenCnt: '3' }] },
    { rank: [{ track: track(1), listenCnt: -1 }] },
    { rank: [{ track: track(1), listenCnt: 1.5 }] },
    { rank: [], from: '0' },
    { rank: [], token: 7 },
    {
      rank: Array.from({ length: 501 }, (_, i) => ({
        track: track(i),
        listenCnt: 1,
      })),
    },
  ])('rejects a malformed reply', async (data) => {
    upstream.state.rpcReplies = { GetRank: { data } };
    const result = await call(`${RANK}?range=week`);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      errorKey: 'upstream.invalid-response',
    });
  });

  it('keeps unknown 1000 as 502 without clearing credentials', async () => {
    upstream.state.rpcReplies = { GetRank: { code: 1000 } };
    const result = await call(`${RANK}?range=week`);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      errorKey: 'upstream.unknown',
      upstreamCode: 1000,
    });
  });

  it('does not retry transport failure or expose private details', async () => {
    upstream.state.networkError = new Error('fixture-private-upstream-token');
    const result = await call(`${RANK}?range=week`);
    expect(result.status).toBe(502);
    expect(upstream.calls).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });
});
