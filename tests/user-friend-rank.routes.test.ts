import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 好友听歌日榜（`FriendRankSvr.GetRank { rank_type: 1 }`）：要登录。2026-11 带会话实测：`my_play_time`
// 等于听歌报告当天的听歌秒数（不等于本周），所以是日榜。只读第一页（官方 App 一次 60 人）；
// 点赞、隐私设置是写入，不做。勋章装饰、音乐力快照不交出。

const friend = (n: number, overrides: Record<string, unknown> = {}) => ({
  uin: `fixture-enc-uin-${n}`,
  nick: `Fixture friend ${n}`,
  pic: `https://thirdqq.qlogo.cn/fixture-${n}.png`,
  play_time: 1000 - n,
  like_num: n,
  like_status: n % 2,
  no: n,
  spInfo: { isValid: 1, name: 'fixture-private-sp' },
  mInfo: { isValid: 1, wearMedal: { medalName: 'fixture-private-medal' } },
  eUin: '',
  ...overrides,
});
const RANK = {
  code: 0,
  ranks: [friend(1), friend(2)],
  my_rank_no: 5,
  my_play_time: 600,
  has_more: 0,
  rankno: 12345,
  my_like_num: 3,
};
const defaults = (): Record<string, Reply> => ({ GetRank: { data: RANK } });

describe.each(['node', 'serverless'] as Runtime[])('friend rank route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(runtime, ctx, '/user/friend-rank', 'GetRank');

  it('limits an oversized ranking and marks more', async () => {
    ctx.replies.GetRank = {
      data: { ...RANK, ranks: Array.from({ length: 61 }, (_, i) => friend(i + 1)) },
    };
    const result = await ctx.call('/user/friend-rank', { token: ctx.token });
    expect(result.status).toBe(200);
    expect(result.body.items.map((item: { rank: number }) => item.rank)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
    expect(result.body.more).toBe(true);
  });

  it('reads the first page of the daily friend ranking', async () => {
    const result = await ctx.call('/user/friend-rank', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      items: [
        {
          uin: 'fixture-enc-uin-1',
          nick: 'Fixture friend 1',
          avatar: 'https://thirdqq.qlogo.cn/fixture-1.png',
          playSeconds: 999,
          likeCount: 1,
          liked: true,
          rank: 1,
        },
        {
          uin: 'fixture-enc-uin-2',
          nick: 'Fixture friend 2',
          avatar: 'https://thirdqq.qlogo.cn/fixture-2.png',
          playSeconds: 998,
          likeCount: 2,
          liked: false,
          rank: 2,
        },
      ],
      myRank: 5,
      myPlaySeconds: 600,
      myLikeCount: 3,
      more: false,
    });
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.activeCenter.FriendRankSvr',
        method: 'GetRank',
        param: { rank_type: 1, offset: 0, limit: 60, last_uin: '', rankno: 0 },
      },
    ]);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('passes has_more through as more without offering a next page', async () => {
    ctx.replies.GetRank = { data: { ...RANK, has_more: 1 } };

    const result = await ctx.call('/user/friend-rank', { token: ctx.token });

    expect(result.body.more).toBe(true);
    expect(result.body).not.toHaveProperty('nextPage');
  });

  it('skips friends without an id and leaves out numbers it cannot read', async () => {
    ctx.replies.GetRank = {
      data: {
        ...RANK,
        my_rank_no: -1,
        ranks: [
          null,
          friend(3, { uin: '' }),
          friend(4, { play_time: '9', like_num: -1, like_status: 7, no: 0 }),
        ],
      },
    };

    const result = await ctx.call('/user/friend-rank', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([
      {
        uin: 'fixture-enc-uin-4',
        nick: 'Fixture friend 4',
        avatar: 'https://thirdqq.qlogo.cn/fixture-4.png',
      },
    ]);
    expect(result.body).not.toHaveProperty('myRank');
  });

  it.each([
    ['an empty list', { ...RANK, ranks: [] }],
    ['null', { ...RANK, ranks: null }],
  ])('no friend on the list (%s) is a normal empty list', async (_label, data) => {
    ctx.replies.GetRank = { data };

    const result = await ctx.call('/user/friend-rank', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body.items).toEqual([]);
  });

  it.each([
    ['a non-list', { ...RANK, ranks: {} }],
    ['nothing readable', { ...RANK, ranks: [friend(5, { uin: null })] }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    ctx.replies.GetRank = { data };

    const result = await ctx.call('/user/friend-rank', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });

  it('a non-zero code inside the data is an upstream failure', async () => {
    ctx.replies.GetRank = { data: { ...RANK, code: 2001, ranks: [] } };

    const result = await ctx.call('/user/friend-rank', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ errorKey: 'upstream.unknown', upstreamCode: 2001 });
  });
});
