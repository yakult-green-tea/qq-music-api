import './helpers/sessionRoutes';
import { CATALOG_RUNTIMES, callRoute } from './helpers/catalogRoutes';
import { type SessionCall, useSessionUpstream } from './helpers/sessionRoutes';

// 替代歌曲：原曲拿不到链接、且命中已验证的不可播规则（地区或会员）时，才从「其他版本」里找。
// 跳过原曲和带已知不可播特征的版本，剩下的合成一次取链接，按版本顺序第一个真拿到链接的才算。
// 编号与名字都是虚构示例。

type Reply = { data?: unknown; code?: number };
const vkeyReply = (mids: string[], granted: string[] = []): Reply => ({
  data: {
    sip: ['https://stream.invalid/'],
    midurlinfo: mids.map((songmid) =>
      granted.includes(songmid)
        ? { songmid, purl: `${songmid}.audio` }
        : { songmid, purl: '', result: 104003, subcode: 1 },
    ),
  },
});
const REGION_DETAIL = { action: { switch: 1, msgid: 23, alert: 0 }, pay: { pay_play: 0 } };
const MEMBERSHIP_DETAIL = {
  action: { switch: 0x101d701, msgid: 13, alert: 21 },
  pay: { pay_play: 1 },
};
const version = (mid: string, extra: Record<string, unknown> = {}) => ({
  id: 90100,
  mid,
  name: `fixture-${mid}`,
  subtitle: '',
  action: { switch: 0x101d701, msgid: 0, alert: 16 },
  pay: { pay_play: 0 },
  ...extra,
});
const vkeyCallsOf = (calls: SessionCall[]) =>
  calls
    .flatMap((call) => call.rpc)
    .filter((rpc) => ['UrlGetVkey', 'CgiGetVkey'].includes(rpc.method));
const methodsOf = (calls: SessionCall[]) =>
  calls.flatMap((call) => call.rpc).map((rpc) => rpc.method);

describe.each(CATALOG_RUNTIMES)('/song/replacement（%s）', (runtime) => {
  const upstream = useSessionUpstream(runtime);
  beforeEach(() =>
    jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000001'),
  );
  const call = async (
    query: string,
    {
      vkeys = [] as Reply[],
      versions,
      authenticated = true,
    }: { vkeys?: Reply[]; versions?: Reply; authenticated?: boolean } = {},
  ) => {
    const options = await upstream.options(authenticated ? 'valid' : 'missing');
    await options.beforeEachLeg?.();
    upstream.state.rpcReplyQueues = { UrlGetVkey: [...vkeys] };
    if (versions) upstream.state.rpcReplies = { GetOtherVersionSongs: versions };
    return callRoute(runtime, `/song/replacement${query}`, {
      headers: options.token ? { 'X-QQ-Session': options.token } : {},
      env: options.env,
    });
  };

  it('原曲被地区规则挡下：有特征的版本排后面，仍可取链接', async () => {
    upstream.state.songDetails = { origA: REGION_DETAIL };
    const list = [
      version('origA'),
      version('verRegion', REGION_DETAIL),
      version('verB', { subtitle: '现场版' }),
      version('verC'),
    ];
    const result = await call('?mid=origA', {
      versions: { data: { id: 90001, versionList: list } },
      vkeys: [
        vkeyReply(['origA']),
        vkeyReply(['verB', 'verC', 'verRegion'], ['verRegion']),
        vkeyReply(['verB', 'verC']),
      ],
    });
    expect(result).toEqual({
      status: 200,
      body: {
        code: 200,
        original: { mid: 'origA', playable: false, hint: 'playback.maybe-region-restricted' },
        song: list[1],
      },
    });
    expect(vkeyCallsOf(upstream.calls).map((rpc) => rpc.param.songmid)).toEqual([
      ['origA'],
      ['verB', 'verC', 'verRegion'],
      ['verB', 'verC'],
    ]);
    const versionCall = upstream.calls
      .flatMap((c) => c.rpc)
      .find((rpc) => rpc.method === 'GetOtherVersionSongs');
    expect(versionCall?.param).toEqual({ songmid: 'origA' });
  });

  it('会员规则同样会找；没有副标题就不给 label，按版本顺序取第一个拿到链接的', async () => {
    upstream.state.songDetails = { origA: MEMBERSHIP_DETAIL };
    const list = [version('verB'), version('verC')];
    const result = await call('?mid=origA', {
      versions: { data: { versionList: list } },
      vkeys: [vkeyReply(['origA']), vkeyReply(['verB', 'verC'], ['verC']), vkeyReply(['verB'])],
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: 200,
      original: { mid: 'origA', playable: false, hint: 'playback.maybe-membership' },
      song: list[1],
    });
  });

  it('最多试 3 个候选，合成一次取链接', async () => {
    upstream.state.songDetails = { origA: REGION_DETAIL };
    const list = ['v1', 'v2', 'v3', 'v4'].map((mid) => version(mid));
    const result = await call('?mid=origA', {
      versions: { data: { versionList: list } },
      vkeys: [vkeyReply(['origA']), vkeyReply(['v1', 'v2', 'v3'], ['v3']), vkeyReply(['v1', 'v2'])],
    });
    expect(result.body).toMatchObject({ song: list[2] });
    // 原因没确认的候选照 /getMusicPlay 的规则再取一次（每首最多多 1 次），不另加次数。
    expect(vkeyCallsOf(upstream.calls).map((rpc) => rpc.param.songmid)).toEqual([
      ['origA'],
      ['v1', 'v2', 'v3'],
      ['v1', 'v2'],
    ]);
  });

  it('会员特征的版本也会排在普通版本后面取链接', async () => {
    upstream.state.songDetails = { origA: REGION_DETAIL };
    const list = [version('member', MEMBERSHIP_DETAIL), version('normal')];
    const result = await call('?mid=origA', {
      versions: { data: { versionList: list } },
      vkeys: [
        vkeyReply(['origA']),
        vkeyReply(['normal', 'member'], ['member']),
        vkeyReply(['normal']),
      ],
    });
    expect(result.body).toMatchObject({ song: list[0] });
    expect(vkeyCallsOf(upstream.calls)[1].param.songmid).toEqual(['normal', 'member']);
  });

  it('原曲拿得到链接：不找替代，也不读其他版本', async () => {
    upstream.state.songDetails = {};
    const result = await call('?mid=origA', { vkeys: [vkeyReply(['origA'], ['origA'])] });
    expect(result).toEqual({
      status: 200,
      body: {
        code: 200,
        original: { mid: 'origA', playable: true, hint: null },
        song: null,
        reason: 'original-playable',
      },
    });
    expect(methodsOf(upstream.calls)).not.toContain('GetOtherVersionSongs');
  });

  // 原因没确认（不是地区、会员规则）时不能当成「这首放不了」，所以不找替代。
  it('原曲失败但原因没确认：不找替代', async () => {
    upstream.state.songDetails = {};
    const result = await call('?mid=origA', {
      vkeys: [vkeyReply(['origA']), vkeyReply(['origA'])],
    });
    expect(result.body).toEqual({
      code: 200,
      original: { mid: 'origA', playable: false, hint: 'playback.reason-unconfirmed' },
      song: null,
      reason: 'reason-unconfirmed',
    });
    expect(methodsOf(upstream.calls)).not.toContain('GetOtherVersionSongs');
  });

  it('没有其他版本，或候选都拿不到链接：回 song:null 与原因', async () => {
    upstream.state.songDetails = { origA: REGION_DETAIL };
    const none = await call('?mid=origA', {
      versions: { data: { versionList: [] } },
      vkeys: [vkeyReply(['origA'])],
    });
    expect(none.body).toMatchObject({ song: null, reason: 'no-other-version' });

    const onlyBlocked = await call('?mid=origA', {
      versions: { data: { versionList: [version('origA'), version('verRegion', REGION_DETAIL)] } },
      vkeys: [vkeyReply(['origA']), vkeyReply(['verRegion']), vkeyReply(['verRegion'])],
    });
    expect(onlyBlocked.body).toMatchObject({ song: null, reason: 'no-playable-version' });

    const notGranted = await call('?mid=origA', {
      versions: { data: { versionList: [version('verB')] } },
      vkeys: [vkeyReply(['origA']), vkeyReply(['verB']), vkeyReply(['verB'])],
    });
    expect(notGranted.body).toMatchObject({ song: null, reason: 'no-playable-version' });
  });

  it('读其他版本被上游拒绝：照新路由的错误回 502，不重试', async () => {
    upstream.state.songDetails = { origA: REGION_DETAIL };
    const result = await call('?mid=origA', {
      versions: { code: 2001 },
      vkeys: [vkeyReply(['origA'])],
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ kind: 'upstream-business', upstreamCode: 2001 });
    expect(methodsOf(upstream.calls).filter((m) => m === 'GetOtherVersionSongs')).toHaveLength(1);
  });

  it('上游明确拒绝取链接凭证时回 401', async () => {
    const result = await call('?mid=origA', { vkeys: [{ code: 1000 }] });
    expect(result.status).toBe(401);
  });

  it('需要会话；mid 必填且只收字母数字', async () => {
    expect((await call('?mid=origA', { authenticated: false })).status).toBe(401);
    for (const query of [
      '',
      '?mid=',
      '?mid=a,b',
      '?mid=a%20b',
      `?mid=${'a'.repeat(65)}`,
      '?id=90001',
    ])
      expect((await call(query)).status).toBe(400);
    expect(upstream.calls).toHaveLength(0);
  });
});
