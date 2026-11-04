import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { useSessionUpstream } from './helpers/sessionRoutes';

// 猜你喜欢按模式取歌：不写账号设置，取歌时带模式目录给的 poolId（get_radio_track 的 ext.scene_id）。
// 上游不写设置是否也认模式还待真账号验收；这里只验请求形状与回包处理。编号、名字都是虚构示例。

const TRACK = { id: 101, mid: 'fixtureModeA', name: 'fixture mode song', singer: [], album: {} };

describe.each(CATALOG_RUNTIMES)('/user/guess-you-like/tracks（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  const call = async (query: string, mode: 'valid' | 'missing' = 'valid') => {
    const options = await upstream.options(mode);
    await options.beforeEachLeg?.();
    return callRoute(runtime, `/user/guess-you-like/tracks${query}`, {
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: options.env,
    });
  };
  const rpcs = () => upstream.calls.flatMap((c) => c.rpc);
  beforeEach(() => {
    upstream.state.rpcReplies = { get_radio_track: { data: { tracks: [TRACK] } } };
  });

  it('asks radio 99 for one batch of the pool, without writing the setting', async () => {
    const result = await call('?pool=1001');

    expect(result).toEqual({
      status: 200,
      body: { code: 200, station: 'guess-you-like', poolId: 1001, songs: [TRACK] },
    });
    expect(rpcs()).toEqual([
      {
        module: 'music.radioProxy.MbTrackRadioSvr',
        method: 'get_radio_track',
        param: { id: 99, num: 5, ext: { scene_id: '1001' } },
      },
    ]);
    expect(rpcs().map((rpc) => rpc.method)).not.toContain('UpdateRadioSceneConfig');
  });

  it('answers 422 for an empty batch and does not ask again', async () => {
    upstream.state.rpcReplies = { get_radio_track: { data: { tracks: null } } };
    const result = await call('?pool=1001');
    expect(result.status).toBe(422);
    expect(rpcs()).toHaveLength(1);
  });

  it('needs a session and a positive whole pool id', async () => {
    expect((await call('?pool=1001', 'missing')).status).toBe(401);
    for (const query of [
      '',
      '?pool=',
      '?pool=0',
      '?pool=-1',
      '?pool=1.5',
      '?pool=abc',
      '?pool=01001',
      `?pool=${'9'.repeat(11)}`,
    ])
      expect((await call(query)).status).toBe(400);
    expect(rpcs()).toEqual([]);
  });
});
