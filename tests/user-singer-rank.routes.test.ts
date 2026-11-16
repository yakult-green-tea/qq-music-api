import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 个人歌手榜（`UserProfileSettingSvr.GetProfileReportDetail`）：要登录。官方 App 的「年／总／月／去年」
// 对应 ShowType 23／25／26／24；2026-11 实测四种都不带 Id 也各回 30 位歌手。年龄、流派、BPM 等其他区块不交出。

const singer = (n: number, overrides: Record<string, unknown> = {}) => ({
  ImgUrl: `https://y.gtimg.cn/fixture-singer-${n}.jpg`,
  Mid: `fixtureSinger${n}`,
  Title: `Fixture singer ${n}`,
  SubTitle: '',
  Num: 100 - n,
  Ranking: n,
  ChangeRanking: n === 2 ? -1 : 0,
  SingerInfoExt: [
    {
      ProportionOf: 30 - n,
      ProportionOfTitle: 'fixture-private-title',
      RecTagInfo: { lp_url: 'x' },
    },
  ],
  ...overrides,
});
const REPORT = {
  ListeningReport: { Report: null },
  Singer: {
    Base: { TypeTitle: 'fixture-private-top', Id: '980000', ShowType: 23 },
    Singers: [singer(1), singer(2)],
  },
  Age: { IndexAge: 1990 },
  Genre: {},
};
const defaults = (): Record<string, Reply> => ({ GetProfileReportDetail: { data: REPORT } });
const answered = (n: number, change: number) => ({
  mid: `fixtureSinger${n}`,
  name: `Fixture singer ${n}`,
  avatar: `https://y.gtimg.cn/fixture-singer-${n}.jpg`,
  rank: n,
  change,
  playCount: 100 - n,
  share: 30 - n,
});

describe.each(['node', 'serverless'] as Runtime[])('singer rank route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(runtime, ctx, '/user/singer-rank?range=year', 'GetProfileReportDetail');

  it.each([
    '/user/singer-rank',
    '/user/singer-rank?range=',
    '/user/singer-rank?range=week',
    '/user/singer-rank?range=YEAR',
    '/user/singer-rank?range=year&range=month',
  ])('%s answers 400 without reaching the upstream', async (path) => {
    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(ctx.recorded).toEqual([]);
  });

  it.each([
    ['year', 23],
    ['all', 25],
    ['month', 26],
    ['last-year', 24],
  ])('range=%s asks ShowType %i for the own account, without a singer Id', async (range, showType) => {
    const result = await ctx.call(`/user/singer-rank?range=${range}`, { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({ code: 200, range, singers: [answered(1, 0), answered(2, -1)] });
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.recommend.UserProfileSettingSvr',
        method: 'GetProfileReportDetail',
        param: { VisitAccount: CONTRACT_CREDENTIAL.encryptUin, ShowType: showType },
      },
    ]);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('skips singers without a mid and leaves out numbers it cannot read', async () => {
    ctx.replies.GetProfileReportDetail = {
      data: {
        Singer: {
          Singers: [
            null,
            singer(3, { Mid: '' }),
            singer(4, { Num: -1, Ranking: '4', ChangeRanking: 1.5, SingerInfoExt: null }),
          ],
        },
      },
    };

    const result = await ctx.call('/user/singer-rank?range=all', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body.singers).toEqual([
      {
        mid: 'fixtureSinger4',
        name: 'Fixture singer 4',
        avatar: 'https://y.gtimg.cn/fixture-singer-4.jpg',
      },
    ]);
  });

  it.each([
    ['an empty list', { Singer: { Singers: [] } }],
    ['null', { Singer: { Singers: null } }],
  ])('no singer yet (%s) is a normal empty list', async (_label, data) => {
    ctx.replies.GetProfileReportDetail = { data };

    const result = await ctx.call('/user/singer-rank?range=month', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, range: 'month', singers: [] });
  });

  it.each([
    ['no singer block', { Age: {} }],
    ['a non-list', { Singer: { Singers: {} } }],
    ['nothing readable', { Singer: { Singers: [singer(5, { Mid: null })] } }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    ctx.replies.GetProfileReportDetail = { data };

    const result = await ctx.call('/user/singer-rank?range=year', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });
});
