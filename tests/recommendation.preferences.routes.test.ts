import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 私人 FM／每日30首共用的音乐偏好只读：从官方偏好页的首屏数据取当前分值，不执行页面脚本。
const profile = (key: string, score: number, extra: Record<string, unknown> = {}) => ({
  ProfileName: `Fixture ${key}`,
  ProfileKey: key,
  CurrentScore: score,
  TargetScore: 0,
  Title: 'Fixture title',
  SubTitle: 'Fixture subtitle',
  IsChangeProfile: true,
  IsBlack: false,
  ...extra,
});
const DATA = {
  ProfileScore: [profile('10008', 50), profile('10003', 75)],
  Songs: [{ mid: 'fixture-private-song' }],
  ShowsTitle: 'Fixture',
  UpdateTime: 1793600000,
};
const page = (data: unknown, code: unknown = 0) =>
  `<!doctype html><html><head><script>window.__ssrFirstPageData__ = ${JSON.stringify({ code, data })};</script></head><body>"fixture { not json"</body></html>`;
const PREFERENCES = '/user/recommendation-preferences';

describe.each(CATALOG_RUNTIMES)('recommendation preferences: %s', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const ssrRequests: Request[] = [];
  let ssr: { status?: number; body?: ConstructorParameters<typeof Response>[0]; error?: Error };
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
  beforeEach(() => {
    ssr = { body: page(DATA) };
    ssrRequests.length = 0;
    const base = jest.mocked(fetch).getMockImplementation();
    jest.mocked(fetch).mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).host === 'i.y.qq.com') {
        ssrRequests.push(request);
        if (ssr.error) throw ssr.error;
        return new Response(ssr.body, {
          status: ssr.status ?? 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return (base as typeof fetch)(input, init);
    });
  });

  it('reads current scores from the official page once, without songs or unknown fields', async () => {
    const result = await call(PREFERENCES);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      scope: 'account',
      profiles: [
        { key: '10008', name: 'Fixture 10008', score: 50 },
        { key: '10003', name: 'Fixture 10003', score: 75 },
      ],
    });
    expect(ssrRequests).toHaveLength(1);
    const url = new URL(ssrRequests[0].url);
    expect(`${url.host}${url.pathname}${url.search}`).toBe(
      'i.y.qq.com/n2/m/client/preferences_set_v2/index.html',
    );
    expect(ssrRequests[0].method).toBe('GET');
    expect(upstream.calls.filter((c) => c.endpoint === '/cgi-bin/musicu.fcg')).toHaveLength(0);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private-song');
  });

  it.each([1, 2])('sends the session credential cookie for loginType %s', async (loginType) => {
    upstream.state.credentialLoginType = loginType;
    upstream.state.credentialOverrides = { musicid: '93001', str_musicid: '93001' };
    expect((await call(PREFERENCES)).status).toBe(200);
    const cookie = ssrRequests[0].headers.get('Cookie') ?? '';
    expect(cookie).toContain('uin=93001');
    expect(cookie).toContain('qqmusic_key=');
  });

  it.each([
    'missing',
    'invalid',
    'expired',
  ] as const)('requires a valid session: %s', async (mode) => {
    expect((await call(PREFERENCES, mode)).status).toBe(401);
    expect(ssrRequests).toHaveLength(0);
  });

  it.each([
    'station=personal-fm',
    'entry=daily',
    'profileKey=10008',
    'page=2',
    'cursor=fixture',
    'id=1',
  ])('rejects unsupported parameters without upstream: %s', async (query) => {
    expect((await call(`${PREFERENCES}?${query}`)).status).toBe(400);
    expect(ssrRequests).toHaveLength(0);
  });

  it.each([
    ['no first-page data', '<html><body>login</body></html>'],
    [
      'two assignments',
      `${page(DATA)}<script>window.__ssrFirstPageData__ = ${JSON.stringify({ code: 0, data: DATA })}</script>`,
    ],
    ['unterminated object', '<script>window.__ssrFirstPageData__ = {"code":0,"data":{</script>'],
    ['invalid json', '<script>window.__ssrFirstPageData__ = {code:0}</script>'],
    ['non-number code', page(DATA, '0')],
    ['missing data', page(undefined)],
    ['profiles not an array', page({ ...DATA, ProfileScore: {} })],
    ['missing key', page({ ...DATA, ProfileScore: [profile('10008', 50, { ProfileKey: 10008 })] })],
    ['non-numeric key', page({ ...DATA, ProfileScore: [profile('abc', 50)] })],
    [
      'duplicate key',
      page({ ...DATA, ProfileScore: [profile('10008', 50), profile('10008', 25)] }),
    ],
    [
      'missing name',
      page({ ...DATA, ProfileScore: [profile('10008', 50, { ProfileName: null })] }),
    ],
    ['fractional score', page({ ...DATA, ProfileScore: [profile('10008', 50.5)] })],
    ['score above 100', page({ ...DATA, ProfileScore: [profile('10008', 101)] })],
    ['negative score', page({ ...DATA, ProfileScore: [profile('10008', -1)] })],
    [
      'too many profiles',
      page({
        ...DATA,
        ProfileScore: Array.from({ length: 33 }, (_, i) => profile(`${10000 + i}`, 50)),
      }),
    ],
    ['oversized page', `${page(DATA)}${' '.repeat(1024 * 1024)}`],
  ])('rejects a malformed or unexpected page: %s', async (_name, body) => {
    ssr.body = body;
    const result = await call(PREFERENCES);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.invalid-response' });
  });

  it('rejects bytes that are not UTF-8', async () => {
    ssr.body = new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]);
    const result = await call(PREFERENCES);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.invalid-response' });
  });

  it('reports an empty profile list as 422', async () => {
    ssr.body = page({ ...DATA, ProfileScore: [] });
    expect((await call(PREFERENCES)).status).toBe(422);
  });

  it('keeps an unknown page code as 502 without clearing credentials', async () => {
    ssr.body = page(DATA, 1000);
    const result = await call(PREFERENCES);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1000 });
  });

  it.each([302, 500])('treats HTTP %s as an upstream failure, not a login loss', async (status) => {
    ssr.status = status;
    ssr.body = 'fixture-private-body';
    const result = await call(PREFERENCES);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('does not retry transport failure or expose private details', async () => {
    ssr.error = new Error('fixture-private-upstream-token');
    const result = await call(PREFERENCES);
    expect(result.status).toBe(502);
    expect(ssrRequests).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });
});
