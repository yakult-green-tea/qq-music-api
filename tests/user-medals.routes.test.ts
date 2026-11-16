import {
  CONTRACT_CREDENTIAL,
  type Reply,
  type Runtime,
  setupSessionRoute,
  sharedSessionReadCases,
} from './helpers/newSessionRoute';

// 勋章馆（`MedalHallHomepageSrv.GetHomepageTabDetail { EncUin, TabID, SupportCardStyle: true }`）：要登录。
// 2026-11 带会话实测的分页对照：2 乐迷、4 畅听、5 限定、6 珍爱守护、11 书迷、12 好友、13 幸运盲盒、
// 14 会员尊享、15 里程碑。回应里也有还没拿到的勋章；`HasNext` 实测都是 false。跳转链接、提示文字不交出。

const medal = (n: number, overrides: Record<string, unknown> = {}) => ({
  MedalID: `fixture${n}`,
  PicURL: `https://y.gtimg.cn/fixture-medal-${n}.png`,
  Name: `Fixture medal ${n}`,
  Label: '',
  CreateTime: n === 1 ? '1790000000' : '',
  Tip: { Style: 1, Content: 'fixture-private-tip' },
  Scheme: 'https://y.qq.com/fixture-private-scheme',
  Level: n,
  IsNew: n === 1,
  TopState: 0,
  SubType: 0,
  ContentList: null,
  ...overrides,
});
const module_ = (id: number, name: string, medals: unknown, hasNext = false) => ({
  ModuleID: id,
  ModuleName: name,
  MedalList: medals,
  Style: {
    Type: 1,
    Scheme: 'https://y.qq.com/fixture-private-more',
    LastPos: '',
    HasNext: hasNext,
  },
  CardList: null,
});
const TAB = {
  TabInfo: {
    ModuleList: [
      module_(4, 'Fixture listening', [medal(1), medal(2)]),
      module_(21, 'Fixture stars', null, true),
    ],
    EmptyInfo: { EmptyType: 0 },
  },
  RedDotInfo: { DotMap: null },
};
const defaults = (): Record<string, Reply> => ({ GetHomepageTabDetail: { data: TAB } });

describe.each(['node', 'serverless'] as Runtime[])('medals route: %s', (runtime) => {
  const ctx = setupSessionRoute(runtime, defaults);
  sharedSessionReadCases(runtime, ctx, '/user/medals?tab=listening', 'GetHomepageTabDetail');

  it.each([
    '/user/medals',
    '/user/medals?tab=',
    '/user/medals?tab=4',
    '/user/medals?tab=Listening',
    '/user/medals?tab=fans&tab=vip',
  ])('%s answers 400 without reaching the upstream', async (path) => {
    const result = await ctx.call(path, { token: ctx.token });

    expect(result.status).toBe(400);
    expect(result.body.errorKey).toBe('input.invalid');
    expect(ctx.recorded).toEqual([]);
  });

  it.each([
    ['fans', 2],
    ['listening', 4],
    ['limited', 5],
    ['guardian', 6],
    ['books', 11],
    ['friends', 12],
    ['blind-box', 13],
    ['vip', 14],
    ['milestones', 15],
  ])('tab=%s asks TabID %i of the own account', async (tab, tabId) => {
    const result = await ctx.call(`/user/medals?tab=${tab}`, { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body.tab).toBe(tab);
    expect(ctx.recorded[0].rpcs).toEqual([
      {
        module: 'music.medalHall.MedalHallHomepageSrv',
        method: 'GetHomepageTabDetail',
        param: { EncUin: CONTRACT_CREDENTIAL.encryptUin, TabID: tabId, SupportCardStyle: true },
      },
    ]);
    expect(ctx.recorded[0].comm).toMatchObject({ ct: 11, authst: CONTRACT_CREDENTIAL.musickey });
  });

  it('keeps modules and medals without links or tips', async () => {
    const result = await ctx.call('/user/medals?tab=listening', { token: ctx.token });

    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(result.body).toEqual({
      code: 200,
      tab: 'listening',
      modules: [
        {
          id: 4,
          name: 'Fixture listening',
          more: false,
          medals: [
            {
              id: 'fixture1',
              name: 'Fixture medal 1',
              icon: 'https://y.gtimg.cn/fixture-medal-1.png',
              level: 1,
              obtainedAt: '1790000000',
              isNew: true,
            },
            {
              id: 'fixture2',
              name: 'Fixture medal 2',
              icon: 'https://y.gtimg.cn/fixture-medal-2.png',
              level: 2,
              isNew: false,
            },
          ],
        },
        { id: 21, name: 'Fixture stars', more: true, medals: [] },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain('fixture-private');
  });

  it('a medal without an id keeps its name; one without a name is skipped', async () => {
    ctx.replies.GetHomepageTabDetail = {
      data: {
        TabInfo: {
          ModuleList: [
            module_(2, '', [
              medal(3, { MedalID: '' }),
              medal(4, { Name: '' }),
              null,
              medal(5, { Level: -1, IsNew: 'x' }),
            ]),
          ],
        },
      },
    };

    const result = await ctx.call('/user/medals?tab=fans', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body.modules).toEqual([
      {
        id: 2,
        name: '',
        more: false,
        medals: [
          {
            name: 'Fixture medal 3',
            icon: 'https://y.gtimg.cn/fixture-medal-3.png',
            level: 3,
            isNew: false,
          },
          {
            id: 'fixture5',
            name: 'Fixture medal 5',
            icon: 'https://y.gtimg.cn/fixture-medal-5.png',
          },
        ],
      },
    ]);
  });

  it.each([
    ['an empty list', { TabInfo: { ModuleList: [] } }],
    ['null', { TabInfo: { ModuleList: null } }],
  ])('an empty tab (%s) is a normal empty list', async (_label, data) => {
    ctx.replies.GetHomepageTabDetail = { data };

    const result = await ctx.call('/user/medals?tab=books', { token: ctx.token });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ code: 200, tab: 'books', modules: [] });
  });

  it.each([
    ['no tab block', { RedDotInfo: {} }],
    ['a non-list', { TabInfo: { ModuleList: {} } }],
    ['nothing readable', { TabInfo: { ModuleList: [{ ModuleName: 'x' }] } }],
    ['a non-object payload', 'x'],
  ])('answers 502 for %s instead of an empty list', async (_label, data) => {
    ctx.replies.GetHomepageTabDetail = { data };

    const result = await ctx.call('/user/medals?tab=vip', { token: ctx.token });

    expect(result.status).toBe(502);
    expect(result.body.errorKey).toBe('upstream.invalid-response');
  });
});
