import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 猜你喜欢（id 99）的单选听歌模式只读目录；不写 RadioConfig，不和普通雷达 radio ID 或偏好 key 混用。
const scene = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: name,
  Pic: `https://fixture.invalid/${id}.png`,
  AnimatedPic: '',
  Status: 0,
  SelectTime: 0,
  EffectiveTime: 0,
  ExpireTime: 0,
  Sort: 0,
  Ext: { pool_id: `7${id}`, top_index: '0', PicDark: '', PicLight: '' },
  Scheme: '',
  ...extra,
});
const TOP = scene('101', 'Fixture explore');
const SCENE = scene('201', 'Fixture scene');
const REC = scene('301', 'Fixture suggested');
const DATA = {
  TopConfigList: [TOP],
  ConfigList: [SCENE],
  SelectConfigList: [SCENE],
  RecommendReason: '',
  RecConfigList: [REC],
  AdjustTime: 0,
  EffectiveDuration: 0,
  Ext: { scene_title: 'Fixture', scene_sub_title: 'Fixture' },
};
const MODES = '/user/guess-you-like/modes';
const item = (s: ReturnType<typeof scene>) => ({
  id: s.Id,
  name: s.Name,
  cover: s.Pic,
  poolId: s.Ext.pool_id,
});

describe.each(CATALOG_RUNTIMES)('guess-you-like modes: %s', (runtime) => {
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
    upstream.state.rpcReplies = { GetRadioSceneConfigs: { data: DATA } };
  });

  it('reads the id99 single-choice catalog and current selection without writing', async () => {
    const result = await call(MODES);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      station: 'guess-you-like',
      radioId: 99,
      selection: 'single',
      primaryModes: [item(TOP)],
      scenes: [item(SCENE)],
      recommended: [item(REC)],
      selectedIds: ['201'],
    });
    expect(upstream.calls.flatMap((c) => c.rpc)).toEqual([
      { module: 'music.startup.RadioConfig', method: 'GetRadioSceneConfigs', param: {} },
    ]);
  });

  it('keeps an empty selection and omits an absent pool id', async () => {
    const plain = scene('202', 'Fixture plain', { Ext: { top_index: '1' } });
    upstream.state.rpcReplies = {
      GetRadioSceneConfigs: {
        data: { ...DATA, ConfigList: [plain], SelectConfigList: [], RecConfigList: [] },
      },
    };
    const result = await call(MODES);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      scenes: [{ id: '202', name: 'Fixture plain', cover: plain.Pic }],
      recommended: [],
      selectedIds: [],
    });
    expect((result.body as { scenes: object[] }).scenes[0]).not.toHaveProperty('poolId');
  });

  it.each([1, 2])('uses returned credential loginType %s', async (loginType) => {
    upstream.state.credentialLoginType = loginType;
    upstream.state.credentialOverrides = { musicid: '93001', str_musicid: '93001' };
    expect((await call(MODES)).status).toBe(200);
    const requests = await Promise.all(
      jest.mocked(fetch).mock.calls.map(async ([input, init]) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const body = url.searchParams.get('data') ?? (await request.text());
        return JSON.parse(body) as { comm: Record<string, unknown> };
      }),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].comm).toMatchObject({ ct: 11, qq: '93001', tmeLoginType: loginType });
  });

  it.each([
    'missing',
    'invalid',
    'expired',
  ] as const)('requires a valid session: %s', async (mode) => {
    expect((await call(MODES, mode)).status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    'id=99',
    'page=2',
    'cursor=fixture',
    'mode=fixture',
    'scene_id=fixture',
    'pool_id=fixture',
  ])('rejects selection or paging parameters without upstream: %s', async (query) => {
    expect((await call(`${MODES}?${query}`)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it.each([
    {},
    [],
    { ...DATA, TopConfigList: {} },
    { ...DATA, ConfigList: null },
    { ...DATA, SelectConfigList: {} },
    { ...DATA, RecConfigList: 'x' },
    { ...DATA, ConfigList: [{}] },
    { ...DATA, ConfigList: [{ ...SCENE, Id: '' }] },
    { ...DATA, ConfigList: [{ ...SCENE, Id: 201 }] },
    { ...DATA, ConfigList: [{ ...SCENE, Name: null }] },
    { ...DATA, ConfigList: [{ ...SCENE, Pic: null }] },
    { ...DATA, ConfigList: [{ ...SCENE, Ext: 'x' }] },
    { ...DATA, ConfigList: [{ ...SCENE, Ext: { pool_id: 7201 } }] },
    { ...DATA, ConfigList: [SCENE, SCENE] },
    { ...DATA, SelectConfigList: [{ Id: '' }] },
    { ...DATA, ConfigList: Array.from({ length: 257 }, (_, i) => scene(`${i + 1}`, 'x')) },
  ])('rejects malformed or excessive catalogs', async (data) => {
    upstream.state.rpcReplies = { GetRadioSceneConfigs: { data } };
    const result = await call(MODES);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.invalid-response' });
  });

  it('reports an empty catalog as 422', async () => {
    upstream.state.rpcReplies = {
      GetRadioSceneConfigs: {
        data: { ...DATA, TopConfigList: [], ConfigList: [], SelectConfigList: [] },
      },
    };
    expect((await call(MODES)).status).toBe(422);
  });

  it('keeps unknown 1000 as 502 without clearing credentials', async () => {
    upstream.state.rpcReplies = { GetRadioSceneConfigs: { code: 1000 } };
    const result = await call(MODES);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 1000 });
  });

  it('keeps unknown outer errors separate from session expiry', async () => {
    upstream.state.globalCode = 1000;
    const result = await call(MODES);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      errorKey: 'upstream.gateway-rejected',
      upstreamGlobalCode: 1000,
    });
  });

  it('does not retry transport failure or expose private details', async () => {
    upstream.state.networkError = new Error('fixture-private-upstream-token');
    const result = await call(MODES);
    expect(result.status).toBe(502);
    expect(upstream.calls).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('leaves the existing guess-you-like batch route unchanged', async () => {
    upstream.state.rpcReplies = {
      get_radio_track: { data: { id: 99, name: 'Fixture', tracks: [{ mid: 'fixture-song' }] } },
    };
    const result = await call('/user/guess-you-like');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ songs: [{ mid: 'fixture-song' }] });
  });
});
