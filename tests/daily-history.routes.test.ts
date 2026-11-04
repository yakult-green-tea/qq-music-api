import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 日推历史只使用上游返回日期与曲数；全部账号、歌曲和时间都是合成数据。
const DATES = [
  { year: 2026, month: 11, day: 1, bSet: false },
  { year: 2026, month: 10, day: 27, bSet: true },
];
const SONG = { id: 101, mid: 'fixture-history-a', name: 'Fixture history song' };
const reply = (data: unknown) => ({ data });

describe.each(CATALOG_RUNTIMES)('daily history: %s', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const call = async (
    path: string,
    mode: 'valid' | 'missing' | 'invalid' | 'expired' = 'valid',
    env?: Record<string, string>,
  ) => {
    const options = await upstream.options(mode);
    await options.beforeEachLeg?.();
    return callRoute(runtime, path, {
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: env ?? options.env,
    });
  };
  beforeEach(() => {
    upstream.state.rpcReplies = {
      get_aiHistoryinfo: reply({ items: DATES, songlist: [{ track: SONG }] }),
    };
  });

  it('returns sparse dates in upstream order without exposing bSet as a subscription', async () => {
    const result = await call('/user/daily-songs/history/dates');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, dates: ['2026-11-01', '2026-10-27'] });
    expect(upstream.calls.flatMap((c) => c.rpc)).toEqual([
      {
        module: 'music.srfDissInfo.aiHistory',
        method: 'get_aiHistoryinfo',
        param: { tid: 0, dirid: 202, spec: {} },
      },
    ]);
  });

  it('unwraps exactly the historical tracks without padding them to thirty', async () => {
    const result = await call('/user/daily-songs/history?date=2026-10-27');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, date: '2026-10-27', songs: [SONG] });
    expect(upstream.calls.flatMap((c) => c.rpc)[0].param).toEqual({
      tid: 0,
      dirid: 202,
      spec: { year: 2026, month: 10, day: 27, bSet: true, optime: 0 },
    });
  });

  it.each([
    undefined,
    '',
    '2026-02-29',
    '2026-11-31',
    '2026-1-01',
    '2026-11-01T00:00:00Z',
  ])('rejects invalid dates without upstream: %s', async (date) => {
    const result = await call(
      `/user/daily-songs/history${date === undefined ? '' : `?date=${date}`}`,
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ errorKey: 'input.invalid' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('accepts a real leap day without shifting to the local timezone', async () => {
    expect((await call('/user/daily-songs/history?date=2024-02-29')).status).toBe(200);
    expect(upstream.calls[0].rpc[0].param.spec).toMatchObject({ year: 2024, month: 2, day: 29 });
  });

  it.each([
    'missing',
    'invalid',
    'expired',
  ] as const)('requires a valid session: %s', async (mode) => {
    const result = await call('/user/daily-songs/history/dates', mode);
    expect(result.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    ['dates', { items: [], songlist: [] }],
    ['songs', { items: DATES, songlist: [] }],
  ])('reports empty %s as 422 rather than missing route', async (kind, data) => {
    upstream.state.rpcReplies = { get_aiHistoryinfo: reply(data) };
    const path =
      kind === 'dates'
        ? '/user/daily-songs/history/dates'
        : '/user/daily-songs/history?date=2026-10-27';
    expect((await call(path)).status).toBe(422);
  });

  it.each([
    ['dates', { items: [{}] }],
    ['dates', { items: [{ year: 2026, month: 2, day: 30 }] }],
    ['dates', { items: {} }],
    ['dates', {}],
    ['songs', { songlist: [{ track: null }] }],
    ['songs', { songlist: {} }],
    ['songs', {}],
  ])('rejects unreadable %s rather than inventing empty data', async (kind, data) => {
    upstream.state.rpcReplies = { get_aiHistoryinfo: reply(data) };
    const path =
      kind === 'dates'
        ? '/user/daily-songs/history/dates'
        : '/user/daily-songs/history?date=2026-10-27';
    const result = await call(path);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.invalid-response' });
  });

  it('does not promote an unverified credential-looking business code to 401', async () => {
    upstream.state.rpcReplies = { get_aiHistoryinfo: { code: 1000 } };
    const result = await call('/user/daily-songs/history/dates');
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1000 });
    expect(upstream.calls).toHaveLength(1);
  });

  it('does not retry a failed history request or expose a private error', async () => {
    upstream.state.rpcReplies = { get_aiHistoryinfo: { httpStatus: 503 } };
    const result = await call('/user/daily-songs/history/dates');
    expect(result.status).toBe(502);
    expect(upstream.calls).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-body');
  });

  if (runtime === 'serverless')
    it('requires a configured session secret', async () => {
      expect((await call('/user/daily-songs/history/dates', 'missing', {})).status).toBe(501);
    });
});
