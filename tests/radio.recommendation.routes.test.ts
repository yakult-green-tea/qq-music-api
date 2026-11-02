import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 官方雷达的单选选项是 radio ID；不写 RadioConfig，不复用私人 FM 的模式声明。
const OPTION = { ID: 91001, Title: 'Fixture scene', BgPicUrl: 'https://fixture.invalid/cover' };
const SONG = { id: 92001, mid: 'fixture-radio-song', name: 'Fixture radio song' };
const MODES = '/radio/recommendation-modes';
const TRACKS = '/radio/recommendation-tracks?id=91001';

describe.each(CATALOG_RUNTIMES)('official radio recommendations: %s', (runtime) => {
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
  beforeEach(() => {
    upstream.state.rpcReplies = {
      GetRecRadioList: { data: { HasMore: 0, Radios: [OPTION] } },
      get_radio_track: { data: { id: 91001, name: 'Fixture scene', tracks: [SONG], extras: [] } },
    };
  });

  it('returns radio-ID options without claiming a saved or complete selection', async () => {
    const result = await call(MODES);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      selection: 'single',
      modes: [{ radioId: 91001, title: 'Fixture scene', cover: OPTION.BgPicUrl }],
      coverage: 'first-page',
      complete: false,
    });
    expect(upstream.calls.flatMap((c) => c.rpc)).toEqual([
      {
        module: 'music.radio.PfRadioSvr',
        method: 'GetRecRadioList',
        param: { Offset: 0, PageSize: 2147483647 },
      },
    ]);
  });

  it('gets one batch by radio ID without manufacturing a settings write or cursor', async () => {
    const result = await call(TRACKS);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      station: 'official-radio',
      radioId: 91001,
      title: 'Fixture scene',
      songs: [SONG],
      extras: [],
    });
    expect(upstream.calls.flatMap((c) => c.rpc)).toEqual([
      {
        module: 'music.radioProxy.MbTrackRadioSvr',
        method: 'get_radio_track',
        param: { id: 91001, num: 5 },
      },
    ]);
  });

  it.each([1, 2])('uses returned credential loginType %s on both new paths', async (loginType) => {
    upstream.state.credentialLoginType = loginType;
    upstream.state.credentialOverrides = { musicid: '93001', str_musicid: '93001' };
    expect((await call(MODES)).status).toBe(200);
    expect((await call(TRACKS)).status).toBe(200);
    const requests = await Promise.all(
      jest.mocked(fetch).mock.calls.map(async ([input, init]) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const body = url.searchParams.get('data') ?? (await request.text());
        return JSON.parse(body) as { comm: Record<string, unknown> };
      }),
    );
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(request.comm).toMatchObject({ ct: 11, qq: '93001', tmeLoginType: loginType });
  });

  it.each([
    'missing',
    'invalid',
    'expired',
  ] as const)('requires a valid session: %s', async (mode) => {
    expect((await call(MODES, mode)).status).toBe(401);
    expect((await call(TRACKS, mode)).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    'abc',
    '99',
    '9007199254740992',
  ])('rejects an invalid or id99 radio ID without upstream: %s', async (id) => {
    expect((await call(`/radio/recommendation-tracks?id=${id}`)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('rejects a missing batch ID and a source-specific catalog query', async () => {
    expect((await call('/radio/recommendation-tracks')).status).toBe(400);
    expect((await call(`${MODES}?id=91001`)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    'page=2',
    'cursor=fixture',
    'mode=fixture',
    'submode=fixture',
    'scene_id=fixture',
  ])('rejects an unsupported selection/paging parameter: %s', async (query) => {
    expect((await call(`${MODES}?${query}`)).status).toBe(400);
    expect((await call(`${TRACKS}&${query}`)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    {},
    [],
    { HasMore: 0, Radios: {} },
    { HasMore: '0', Radios: [OPTION] },
    { HasMore: 0, Radios: [{}] },
    { HasMore: 0, Radios: [{ ...OPTION, ID: 0 }] },
    { HasMore: 0, Radios: [{ ...OPTION, Title: null }] },
    { HasMore: 0, Radios: [{ ...OPTION, BgPicUrl: null }] },
    { HasMore: 0, Radios: [OPTION, OPTION] },
    { HasMore: 0, Radios: Array.from({ length: 257 }, (_, i) => ({ ...OPTION, ID: i + 1 })) },
  ])('rejects malformed or excessive mode catalogs', async (data) => {
    upstream.state.rpcReplies = { GetRecRadioList: { data } };
    const result = await call(MODES);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.invalid-response' });
  });

  it.each([
    {},
    [],
    { id: 91001, name: 'Fixture', tracks: {} },
    { id: 91002, name: 'Fixture', tracks: [SONG] },
    { id: '91001', name: 'Fixture', tracks: [SONG] },
    { id: 91001, name: null, tracks: [SONG] },
    { id: 91001, name: 'Fixture', tracks: [SONG], extras: {} },
  ])('rejects malformed or mismatched batches', async (data) => {
    upstream.state.rpcReplies = { get_radio_track: { data } };
    expect((await call(TRACKS)).status).toBe(502);
  });

  it('allows optional extras to be absent and keeps each requested batch independent', async () => {
    upstream.state.rpcReplies = {
      get_radio_track: { data: { id: 91002, name: 'Fixture other', tracks: [SONG] } },
    };
    const result = await call('/radio/recommendation-tracks?id=91002');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ radioId: 91002, songs: [SONG] });
    expect(result.body).not.toHaveProperty('extras');
    expect(upstream.calls[0].rpc[0].param).toEqual({ id: 91002, num: 5 });
  });

  it.each([
    MODES,
    TRACKS,
  ])('keeps unknown 1000 as 502 without clearing credentials: %s', async (path) => {
    upstream.state.rpcReplies = {
      GetRecRadioList: { code: 1000 },
      get_radio_track: { code: 1000 },
    };
    const result = await call(path);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1000 });
  });

  it.each([
    MODES,
    TRACKS,
  ])('keeps unknown outer errors separate from session expiry: %s', async (path) => {
    upstream.state.globalCode = 1000;
    const result = await call(path);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      errorKey: 'upstream.gateway-rejected',
      upstreamGlobalCode: 1000,
    });
  });

  it.each([
    MODES,
    TRACKS,
  ])('reports empty content as 422, keeping the route distinct: %s', async (path) => {
    upstream.state.rpcReplies = {
      GetRecRadioList: { data: { HasMore: 0, Radios: [] } },
      get_radio_track: { data: { id: 91001, name: 'Fixture', tracks: [] } },
    };
    expect((await call(path)).status).toBe(422);
  });

  it.each([
    MODES,
    TRACKS,
  ])('does not retry transport failure or expose private details: %s', async (path) => {
    upstream.state.networkError = new Error('fixture-private-upstream-token');
    const result = await call(path);
    expect(result.status).toBe(502);
    expect(upstream.calls).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });
});
