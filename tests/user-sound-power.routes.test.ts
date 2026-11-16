import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 音乐力等级（`SoundPowerSvr.QueryLevelDetailPage {}`）：要登录。2026-11 带会话实测：`todayLT` 等于听歌报告
// 当天的听歌秒数；`reachMaxLevel` 只见过 0／1，是「是否到最高级」的旗标，不是等级数。权益、跳转链接、
// 昵称头像不交出。

const PAGE = {
  powerInfo: {
    level: 6,
    value: 12000,
    name: 'Fixture level',
    icon: 'https://y.gtimg.cn/fixture-level.png',
    currentValue: 2000,
    nextValue: 5000,
    reachMaxLevel: 0,
    isHugeVip: false,
    nextLevelIcon: '',
  },
  medalNum: 42,
  nick: 'fixture-private-nick',
  headPic: 'https://y.gtimg.cn/fixture-private-head.png',
  todayLT: 3600,
  equities: [{ eType: 1, name: 'fixture', scheme: 'https://y.qq.com/fixture-private-scheme' }],
  medalScheme: 'https://y.qq.com/fixture-private-medal',
};
const defaults = (): Record<string, Reply> => ({ QueryLevelDetailPage: { data: PAGE } });

describe.each(['node', 'serverless'] as Runtime[])('sound power route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(runtime, ctx, '/user/sound-power', 'QueryLevelDetailPage');

  it('reads the level page once and keeps only the level numbers', async () => {
    const result = await ctx.call('/user/sound-power', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      level: 6,
      name: 'Fixture level',
      icon: 'https://y.gtimg.cn/fixture-level.png',
      value: 12000,
      currentValue: 2000,
      nextValue: 5000,
      reachedMaxLevel: false,
      medalCount: 42,
      todayListenSeconds: 3600,
    });
    expect(ctx.recorded[0].rpcs).toEqual([
      { module: 'music.soundPower.SoundPowerSvr', method: 'QueryLevelDetailPage', param: {} },
    ]);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('reachMaxLevel 1 is true; any other value is left out instead of guessed', async () => {
    ctx.replies.QueryLevelDetailPage = {
      data: { ...PAGE, powerInfo: { ...PAGE.powerInfo, reachMaxLevel: 1 } },
    };
    const reached = await ctx.call('/user/sound-power', { token: ctx.token });
    expect(reached.body.reachedMaxLevel).toBe(true);

    ctx.replies.QueryLevelDetailPage = {
      data: { ...PAGE, powerInfo: { ...PAGE.powerInfo, reachMaxLevel: 7 } },
    };
    const odd = await ctx.call('/user/sound-power', { token: ctx.token });
    expect(odd.status).toBe(200);
    expect(odd.body).not.toHaveProperty('reachedMaxLevel');
  });

  it('leaves out numbers it cannot read', async () => {
    ctx.replies.QueryLevelDetailPage = {
      data: {
        powerInfo: { level: 2, name: 'Fixture', value: -1, currentValue: '5', nextValue: 1.5 },
        todayLT: null,
      },
    };

    const result = await ctx.call('/user/sound-power', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, level: 2, name: 'Fixture', icon: '' });
  });

  it.each([
    ['no level block', { medalNum: 1 }],
    ['a level block without a level', { powerInfo: { name: 'x' } }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s', async (_label, data) => {
    ctx.replies.QueryLevelDetailPage = { data };

    const result = await ctx.call('/user/sound-power', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });
});
